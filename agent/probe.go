package main

// 探针（只读）：
//   - 每台 VPS 的 agent 在订阅端口提供 /probe/data（要带只读密钥），返回实时 CPU / 网速、监控曲线、本月流量
//   - 选为主控的那台定时拉所有机器的数据，在订阅端口 /p/<口令>/ 出一个网页，手机浏览器就能看
//   - 主控发现某台连不上（1 分钟没回应）就发通知（Telegram / 微信），恢复后再发一次
//   - 只读：没有远程命令、终端、文件管理；网页和接口里都不出现 IP
import (
	"crypto/subtle"
	"crypto/tls"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed probe.html
var probeHTML []byte

type ProbeCfg struct {
	Key  string     `json:"key"`            // 本机 /probe/data 的只读密钥
	Host *ProbeHost `json:"host,omitempty"` // 只有主控有
}

type ProbeHost struct {
	Token string      `json:"token"` // 网页口令（链接里的随机路径）
	Title string      `json:"title"`
	Alert bool        `json:"alert"` // 离线 / 恢复发通知
	Peers []ProbePeer `json:"peers"`
}

type ProbePeer struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	CC       string  `json:"cc"`   // 国家 / 地区代码，显示旗帜
	Addr     string  `json:"addr"` // host:订阅端口（只在主控上用，不会出现在网页里）
	Key      string  `json:"key"`
	Self     bool    `json:"self"`
	ExpireAt int64   `json:"expireAt"` // 秒，0 = 没填
	QuotaGB  float64 `json:"quotaGB"`  // 月流量额度，0 = 没填
	MemMB    int     `json:"memMB"`
	Group    string  `json:"group"`
}

// probeData /probe/data 的返回
type probeData struct {
	metricsResp
	Live    *Sample `json:"live"` // 实时（距上次请求的平均）CPU / 内存 / 网速
	Version string  `json:"version"`
	NodeOK  bool    `json:"nodeOk"` // sing-box 统计能读到 = 节点服务正常
	At      int64   `json:"at"`
}

// liveSampler 按两次请求之间的差值算实时 CPU 和网速（主控每 5 秒拉一次）
type liveSampler struct {
	mu                sync.Mutex
	t                 time.Time
	idle, total       uint64
	rx, tx            uint64
	cpu, rxRate, txRt float64
}

func (l *liveSampler) sample() Sample {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	idle, total := readCPU()
	rx, tx := readNet()
	if !l.t.IsZero() && now.Sub(l.t) > 500*time.Millisecond {
		secs := now.Sub(l.t).Seconds()
		if dt := float64(total - l.total); total > l.total && dt > 0 {
			l.cpu = 100 * (1 - float64(idle-l.idle)/dt)
		}
		if rx >= l.rx && tx >= l.tx {
			l.rxRate = float64(rx-l.rx) / secs
			l.txRt = float64(tx-l.tx) / secs
		}
	}
	if now.Sub(l.t) > 500*time.Millisecond {
		l.t, l.idle, l.total, l.rx, l.tx = now, idle, total, rx, tx
	}
	return Sample{T: now.Unix(), CPU: round1(l.cpu), Mem: round1(readMem()), Rx: l.rxRate, Tx: l.txRt, Load: readLoad()}
}

func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }

func (a *Agent) probeData(rng string) probeData {
	d := probeData{metricsResp: a.metricsFor(rng), Version: version, At: time.Now().Unix()}
	if rng == "now" {
		d.Series = nil
	}
	live := a.live.sample()
	d.Live = &live
	a.mu.Lock()
	d.NodeOK = a.lastErr == ""
	a.mu.Unlock()
	return d
}

func bearerOK(r *http.Request, key string) bool {
	if key == "" {
		return false
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(key)) == 1
}

// handleProbeData 主控来拉数据
func (a *Agent) handleProbeData(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Probe == nil || !bearerOK(r, a.cfg.Probe.Key) {
		http.NotFound(w, r)
		return
	}
	rng := r.URL.Query().Get("range")
	if rng != "24h" && rng != "30d" {
		rng = "now"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(a.probeData(rng))
}

// ---------- 主控 ----------

type peerState struct {
	Data         *probeData
	LastOK       time.Time
	Online       bool
	Seen         bool // 启动后连上过
	OfflineSince time.Time
	Alerted      bool // 已发过离线告警
	Err          string
	HTTPS        bool // 上次用 https 成功
	httpsRetryAt time.Time
}

type probeHub struct {
	mu    sync.Mutex
	peers map[string]*peerState
	start time.Time
}

var probeClient = &http.Client{Timeout: 6 * time.Second, Transport: &http.Transport{
	Proxy:                 nil,
	TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	MaxIdleConnsPerHost:   2,
	IdleConnTimeout:       60 * time.Second,
	ResponseHeaderTimeout: 6 * time.Second,
	DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
}}

// fetchPeer 先用 https（对方有 IP 证书时，证书校验通过才算），不行再用 http（订阅端口两种都接受）
func fetchPeer(p ProbePeer, st *peerState, rng string) (*probeData, bool, error) {
	try := func(scheme string) (*probeData, error) {
		req, _ := http.NewRequest("GET", fmt.Sprintf("%s://%s/probe/data?range=%s", scheme, p.Addr, rng), nil)
		req.Header.Set("Authorization", "Bearer "+p.Key)
		resp, err := probeClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("HTTP %d（这台的 agent 可能还没同步到 0.8.9）", resp.StatusCode)
		}
		var d probeData
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&d); err != nil {
			return nil, err
		}
		return &d, nil
	}
	useHTTPS := st == nil || st.HTTPS || time.Now().After(st.httpsRetryAt)
	if useHTTPS {
		if d, err := try("https"); err == nil {
			return d, true, nil
		}
	}
	d, err := try("http")
	return d, false, err
}

func (a *Agent) probeLoop() {
	if a.cfg.Probe == nil || a.cfg.Probe.Host == nil {
		return
	}
	a.hub = &probeHub{peers: map[string]*peerState{}, start: time.Now()}
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		a.probeRound()
		<-tick.C
	}
}

func (a *Agent) probeRound() {
	host := a.cfg.Probe.Host
	var wg sync.WaitGroup
	for _, p := range host.Peers {
		p := p
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.hub.mu.Lock()
			st := a.hub.peers[p.ID]
			if st == nil {
				st = &peerState{}
				a.hub.peers[p.ID] = st
			}
			cp := *st
			a.hub.mu.Unlock()
			var d *probeData
			var https bool
			var err error
			if p.Self {
				v := a.probeData("now")
				d = &v
			} else {
				d, https, err = fetchPeer(p, &cp, "now")
			}
			now := time.Now()
			a.hub.mu.Lock()
			defer a.hub.mu.Unlock()
			if err == nil {
				if !p.Self {
					st.HTTPS = https
					if !https {
						st.httpsRetryAt = now.Add(30 * time.Minute)
					}
				}
				wasDown := st.Seen && !st.Online
				down := now.Sub(st.OfflineSince)
				st.Data, st.LastOK, st.Online, st.Seen, st.Err = d, now, true, true, ""
				if wasDown && st.Alerted && host.Alert {
					go a.probeNotify(fmt.Sprintf("🟢 %s 恢复在线（离线了 %s）", p.Name, fmtDur(down)))
				}
				st.Alerted = false
				return
			}
			st.Err = err.Error()
			// 1 分钟没回应算离线；启动后从没连上过的，从启动时刻算
			ref := st.LastOK
			if ref.IsZero() {
				ref = a.hub.start
			}
			if now.Sub(ref) >= time.Minute && (st.Online || !st.Seen) {
				if st.Online || st.OfflineSince.IsZero() {
					st.OfflineSince = ref
				}
				st.Online = false
				if host.Alert && !st.Alerted {
					st.Alerted = true
					st.Seen = true // 这样恢复时也会通知
					go a.probeNotify(fmt.Sprintf("🔴 %s 离线：探针 1 分钟没收到它的数据（%s）", p.Name, shortErr(err)))
				}
			}
		}()
	}
	wg.Wait()
}

func (a *Agent) probeNotify(text string) {
	if !a.notifyOn() {
		return
	}
	if err := a.sendAll("【探针】" + text); err != nil {
		log.Printf("发送探针告警失败: %v", err)
	}
}

func shortErr(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "connection refused"):
		return "端口拒绝连接，agent 可能没在运行"
	case strings.Contains(s, "timeout") || strings.Contains(s, "deadline"):
		return "连接超时，机器可能宕机或网络断了"
	case strings.Contains(s, "no route") || strings.Contains(s, "unreachable"):
		return "网络不可达"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func fmtDur(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d 秒", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%d 分钟", int(d.Minutes()))
	}
	if d < 48*time.Hour {
		return fmt.Sprintf("%d 小时 %d 分钟", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%d 天", int(d.Hours()/24))
}

// ---------- 网页 ----------

type probeServerView struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	CC       string     `json:"cc"`
	Group    string     `json:"group"`
	Online   bool       `json:"online"`
	Since    int64      `json:"since"` // 离线开始时间（秒）
	LastOK   int64      `json:"lastOk"`
	ExpireAt int64      `json:"expireAt"`
	QuotaGB  float64    `json:"quotaGB"`
	MemMB    int        `json:"memMB"`
	Data     *probeData `json:"data"`
}

func (a *Agent) probeToken(r *http.Request) (rest string, ok bool) {
	h := a.cfg.Probe.Host
	p := strings.TrimPrefix(r.URL.Path, "/p/")
	tok, rest, _ := strings.Cut(p, "/")
	return rest, h.Token != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(h.Token)) == 1
}

func (a *Agent) handleProbePage(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Probe == nil || a.cfg.Probe.Host == nil || a.hub == nil {
		http.NotFound(w, r)
		return
	}
	rest, ok := a.probeToken(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	hd := w.Header()
	hd.Set("Referrer-Policy", "no-referrer")
	hd.Set("X-Robots-Tag", "noindex, nofollow")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Cache-Control", "no-store")
	host := a.cfg.Probe.Host
	switch rest {
	case "":
		hd.Set("Content-Type", "text/html; charset=utf-8")
		hd.Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		w.Write(probeHTML)
	case "api/servers":
		a.hub.mu.Lock()
		out := make([]probeServerView, 0, len(host.Peers))
		for _, p := range host.Peers {
			v := probeServerView{ID: p.ID, Name: p.Name, CC: p.CC, Group: p.Group, ExpireAt: p.ExpireAt, QuotaGB: p.QuotaGB, MemMB: p.MemMB}
			if st := a.hub.peers[p.ID]; st != nil {
				v.Online, v.Data = st.Online, st.Data
				if !st.LastOK.IsZero() {
					v.LastOK = st.LastOK.Unix()
				}
				if !st.Online && !st.OfflineSince.IsZero() {
					v.Since = st.OfflineSince.Unix()
				}
			}
			out = append(out, v)
		}
		a.hub.mu.Unlock()
		hd.Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"title": host.Title, "servers": out, "now": time.Now().Unix()})
	case "api/history":
		id := r.URL.Query().Get("id")
		rng := r.URL.Query().Get("range")
		if rng != "30d" {
			rng = "24h"
		}
		var peer *ProbePeer
		for i := range host.Peers {
			if host.Peers[i].ID == id {
				peer = &host.Peers[i]
			}
		}
		if peer == nil {
			http.NotFound(w, r)
			return
		}
		var d *probeData
		var err error
		if peer.Self {
			v := a.probeData(rng)
			d = &v
		} else {
			a.hub.mu.Lock()
			var cp peerState
			if st := a.hub.peers[id]; st != nil {
				cp = *st
			}
			a.hub.mu.Unlock()
			d, _, err = fetchPeer(*peer, &cp, rng)
		}
		hd.Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(502)
			json.NewEncoder(w).Encode(map[string]string{"error": "读不到这台的数据：" + shortErr(err)})
			return
		}
		json.NewEncoder(w).Encode(d)
	default:
		http.NotFound(w, r)
	}
}

// probeStatus 给桌面端看的主控状态（每台连得上连不上、为什么）
func (a *Agent) probeStatus() map[string]any {
	if a.hub == nil {
		return nil
	}
	a.hub.mu.Lock()
	defer a.hub.mu.Unlock()
	type row struct {
		ID     string `json:"id"`
		Online bool   `json:"online"`
		HTTPS  bool   `json:"https"`
		Err    string `json:"error,omitempty"`
	}
	var rows []row
	for id, st := range a.hub.peers {
		rows = append(rows, row{ID: id, Online: st.Online, HTTPS: st.HTTPS, Err: st.Err})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return map[string]any{"peers": rows}
}
