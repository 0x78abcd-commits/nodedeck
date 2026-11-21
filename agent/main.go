// NodeDeck agent：运行在 VPS 上
//   - 通过 sing-box V2Ray Stats API 按用户精确统计流量
//   - 到期 / 超额 / 停用的用户自动从配置中移除并热重载 sing-box
//   - 提供订阅服务 /sub/<token>（v2rayN base64 / Clash Meta）
//   - 本机管理接口（仅 127.0.0.1）供桌面端通过 SSH 调用
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var version = "dev"

type Config struct {
	StatsAPI    string `json:"statsApi"`
	SubListen   string `json:"subListen"`
	AdminListen string `json:"adminListen"`
	DataDir     string `json:"dataDir"`
	SingBox     string `json:"singbox"`
	Service     string `json:"service"`
	// ReloadCmd 为空时使用 systemctl reload <Service>
	ReloadCmd []string `json:"reloadCmd"`
	// sing-box 自动升级
	SingboxManifest   string `json:"singboxManifest"`
	SingboxAutoUpdate bool   `json:"singboxAutoUpdate"`
	// 内核自动升级时间段（本地小时，[开始, 结束)），为空表示随时
	UpgradeWindow []int          `json:"upgradeWindow"`
	Timezone      string         `json:"timezone"`
	ServerName    string         `json:"serverName"`
	Telegram      TelegramConfig `json:"telegram"`
	UDPHops       []UDPHop       `json:"udpHops"`
	// 0.5.0 起
	Init           string            `json:"init"` // systemd（默认）或 openrc
	LatencyTargets map[string]string `json:"latencyTargets"`
	VPSExpireAt    int64             `json:"vpsExpireAt"`
}

type User struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Enabled    bool   `json:"enabled"`
	LimitBytes int64  `json:"limitBytes"`
	BaseUsed   int64  `json:"baseUsed"`
	ExpireAt   int64  `json:"expireAt"`
	// 流量重置：none / day / week / month / rolling30
	ResetPeriod     string `json:"resetPeriod"`
	ResetDay        int    `json:"resetDay"`
	ResetAnchor     int64  `json:"resetAnchor"`
	BaseUsedAt      int64  `json:"baseUsedAt"`
	ExpireAfterDays int    `json:"expireAfterDays"`
	FirstUsedAt     int64  `json:"firstUsedAt"`
	Notify          bool   `json:"notify"` // 由这台服务器负责发该用户的提醒
}

type Sub struct {
	UserID string `json:"userId"`
	Name   string `json:"name"`
	V2ray  string `json:"v2ray"`
	Clash  string `json:"clash"`
	Total  int64  `json:"total"`
	Expire int64  `json:"expire"`
	// 0.3.0 起
	Singbox         string `json:"singbox"`
	QR              string `json:"qr"`
	URL             string `json:"url"`
	ExpireAfterDays int    `json:"expireAfterDays"`
}

type Traffic struct {
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

type Agent struct {
	cfg      Config
	mu       sync.Mutex
	traffic  map[string]*Traffic
	users    map[string]User
	subs     map[string]Sub
	disabled map[string]string // id -> reason
	applied  string            // 已应用的禁用集合签名
	lastErr  string
	started  time.Time
	update   UpdateState
	dirty    bool
	st       AgentState
	primed   bool // 启动后是否已完成第一次检查
	metrics  *Metrics
}

func (a *Agent) path(name string) string { return filepath.Join(a.cfg.DataDir, name) }

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeFileAtomic(path string, b []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *Agent) loadData() {
	var users []User
	if err := readJSON(a.path("users.json"), &users); err != nil && !os.IsNotExist(err) {
		log.Printf("读取 users.json 失败: %v", err)
	}
	subs := map[string]Sub{}
	if err := readJSON(a.path("subs.json"), &subs); err != nil && !os.IsNotExist(err) {
		log.Printf("读取 subs.json 失败: %v", err)
	}
	m := map[string]User{}
	for _, u := range users {
		m[u.ID] = u
	}
	a.mu.Lock()
	a.users = m
	a.subs = subs
	a.mu.Unlock()
}

func (a *Agent) loadTraffic() {
	t := map[string]*Traffic{}
	_ = readJSON(a.path("traffic.json"), &t)
	a.traffic = t
}

func (a *Agent) saveTraffic() {
	a.mu.Lock()
	if !a.dirty {
		a.mu.Unlock()
		return
	}
	b, _ := json.Marshal(a.traffic)
	sb := a.stateBytes()
	a.dirty = false
	a.mu.Unlock()
	if err := writeFileAtomic(a.path("traffic.json"), b, 0600); err != nil {
		log.Printf("保存流量失败: %v", err)
	}
	if err := writeFileAtomic(a.path("state.json"), sb, 0600); err != nil {
		log.Printf("保存状态失败: %v", err)
	}
}

// ---------- V2Ray Stats API（gRPC over h2c，手写最小 protobuf 编解码） ----------
func pbVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func readVarint(b []byte) (uint64, int) {
	var v uint64
	for i := 0; i < len(b) && i < 10; i++ {
		v |= uint64(b[i]&0x7f) << (7 * i)
		if b[i] < 0x80 {
			return v, i + 1
		}
	}
	return 0, 0
}

// 解析 QueryStatsResponse{ repeated Stat stat = 1 }，Stat{ string name = 1; int64 value = 2 }
func parseStats(b []byte) map[string]int64 {
	out := map[string]int64{}
	for len(b) > 0 {
		tag, n := readVarint(b)
		if n == 0 {
			break
		}
		b = b[n:]
		if tag>>3 != 1 || tag&7 != 2 {
			break
		}
		l, n := readVarint(b)
		if n == 0 || int(l) > len(b)-n {
			break
		}
		msg := b[n : n+int(l)]
		b = b[n+int(l):]
		var name string
		var val int64
		for len(msg) > 0 {
			t, n := readVarint(msg)
			if n == 0 {
				break
			}
			msg = msg[n:]
			switch {
			case t>>3 == 1 && t&7 == 2:
				l, n := readVarint(msg)
				if n == 0 || int(l) > len(msg)-n {
					msg = nil
					break
				}
				name = string(msg[n : n+int(l)])
				msg = msg[n+int(l):]
			case t>>3 == 2 && t&7 == 0:
				v, n := readVarint(msg)
				val = int64(v)
				msg = msg[n:]
			default:
				msg = nil
			}
		}
		out[name] = val
	}
	return out
}

var grpcClient = func() *http.Client {
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Protocols: p}}
}()

// queryStats 调用 QueryStats(pattern="user>>>", reset=true)，返回自上次以来的增量
func (a *Agent) queryStats() (map[string]int64, error) {
	var msg []byte
	msg = pbVarint(msg, 1<<3|2)
	msg = pbVarint(msg, uint64(len("user>>>")))
	msg = append(msg, "user>>>"...)
	msg = append(msg, 2<<3|0, 1)
	frame := make([]byte, 5, 5+len(msg))
	frame[1], frame[2], frame[3], frame[4] = byte(len(msg)>>24), byte(len(msg)>>16), byte(len(msg)>>8), byte(len(msg))
	frame = append(frame, msg...)
	req, _ := http.NewRequest("POST", "http://"+a.cfg.StatsAPI+"/v2ray.core.app.stats.command.StatsService/QueryStats", bytes.NewReader(frame))
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("TE", "trailers")
	resp, err := grpcClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	for _, h := range []http.Header{resp.Header, resp.Trailer} {
		if st := h.Get("Grpc-Status"); st != "" && st != "0" {
			return nil, fmt.Errorf("grpc status %s: %s", st, h.Get("Grpc-Message"))
		}
	}
	if len(body) < 5 {
		return map[string]int64{}, nil
	}
	l := int(body[1])<<24 | int(body[2])<<16 | int(body[3])<<8 | int(body[4])
	if l > len(body)-5 {
		return nil, fmt.Errorf("响应不完整")
	}
	return parseStats(body[5 : 5+l]), nil
}

func (a *Agent) poll() {
	stats, err := a.queryStats()
	a.mu.Lock()
	defer a.mu.Unlock()
	if err != nil {
		a.lastErr = "无法读取 sing-box 统计: " + err.Error()
		return
	}
	a.lastErr = ""
	now := time.Now().Unix()
	for name, v := range stats {
		// user>>>ID>>>traffic>>>uplink|downlink
		parts := strings.Split(name, ">>>")
		if len(parts) != 4 || v == 0 {
			continue
		}
		t := a.traffic[parts[1]]
		if t == nil {
			t = &Traffic{}
			a.traffic[parts[1]] = t
		}
		if parts[3] == "uplink" {
			t.Up += v
			a.markActive(parts[1], v, 0, now)
		} else {
			t.Down += v
			a.markActive(parts[1], 0, v, now)
		}
		a.dirty = true
	}
}

// ---------- 用户状态与配置应用 ----------
func (a *Agent) computeDisabled() map[string]string {
	now := time.Now().Unix()
	a.mu.Lock()
	defer a.mu.Unlock()
	out := map[string]string{}
	for id, u := range a.users {
		used, expire := a.effective(u)
		switch {
		case !u.Enabled:
			out[id] = "disabled"
		case expire > 0 && now >= expire:
			out[id] = "expired"
		case u.LimitBytes > 0 && used >= u.LimitBytes:
			out[id] = "quota"
		}
	}
	return out
}

func signature(m map[string]string) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

func filterConfig(full []byte, disabled map[string]string) ([]byte, error) {
	var cfg map[string]any
	if err := json.Unmarshal(full, &cfg); err != nil {
		return nil, err
	}
	if inbounds, ok := cfg["inbounds"].([]any); ok {
		for _, ib := range inbounds {
			m, ok := ib.(map[string]any)
			if !ok {
				continue
			}
			users, ok := m["users"].([]any)
			if !ok {
				continue
			}
			kept := make([]any, 0, len(users))
			for _, u := range users {
				um, _ := u.(map[string]any)
				name, _ := um["name"].(string)
				if _, off := disabled[name]; off {
					continue
				}
				kept = append(kept, u)
			}
			m["users"] = kept
		}
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func (a *Agent) reloadSingBox() error {
	var cmd *exec.Cmd
	if len(a.cfg.ReloadCmd) > 0 {
		cmd = exec.Command(a.cfg.ReloadCmd[0], a.cfg.ReloadCmd[1:]...)
	} else {
		return a.svcReload(a.cfg.Service)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

// apply 根据当前禁用集合生成 config.json；force=true 时无论是否变化都重载
func (a *Agent) apply(force bool) error {
	now := time.Now()
	a.mu.Lock()
	a.rollPeriods(now)
	a.rollDay(now)
	a.mu.Unlock()
	disabled := a.computeDisabled()
	sig := signature(disabled)
	a.mu.Lock()
	changed := sig != a.applied
	prev := a.disabled
	a.disabled = disabled
	a.checkNotices(now, prev, disabled)
	a.mu.Unlock()
	if !changed && !force {
		return nil
	}
	full, err := os.ReadFile(a.path("config.full.json"))
	if err != nil {
		return fmt.Errorf("读取 config.full.json: %w", err)
	}
	out, err := filterConfig(full, disabled)
	if err != nil {
		return err
	}
	tmp := a.path("config.check.json")
	if err := os.WriteFile(tmp, out, 0600); err != nil {
		return err
	}
	if b, err := exec.Command(a.cfg.SingBox, "check", "-c", tmp).CombinedOutput(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("配置校验失败: %s", strings.TrimSpace(string(b)))
	}
	if err := os.Rename(tmp, a.path("config.json")); err != nil {
		return err
	}
	a.poll() // 重载会清零计数，先把增量收上来
	if err := a.reloadSingBox(); err != nil {
		return err
	}
	a.mu.Lock()
	a.applied = sig
	a.mu.Unlock()
	_ = prev
	log.Printf("已应用配置，停用用户: [%s]", sig)
	return nil
}

// ---------- HTTP ----------
// 订阅接口按 IP 限频：每分钟最多 30 次（防扫描、防暴力猜 token）
type rateLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *rateLimiter) allow(ip string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	if len(l.hits) > 10000 { // 防止内存无限增长
		l.hits = map[string][]time.Time{}
	}
	list := l.hits[ip]
	kept := list[:0]
	for _, t := range list {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= limit {
		l.hits[ip] = kept
		return false
	}
	l.hits[ip] = append(kept, now)
	return true
}

var subLimiter rateLimiter

func clientIP(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

func (a *Agent) handleSub(w http.ResponseWriter, r *http.Request) {
	if !subLimiter.allow(clientIP(r), 30, time.Minute) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/sub/")
	a.mu.Lock()
	s, ok := a.subs[token]
	var up, down, used, expire int64
	var reason string
	if ok {
		if t := a.traffic[s.UserID]; t != nil {
			up, down = t.Up, t.Down
		}
		if u, ok2 := a.users[s.UserID]; ok2 {
			used, expire = a.effective(u)
			down = used - up
			reason = a.disabled[s.UserID]
		}
	}
	a.mu.Unlock()
	if !ok || token == "" {
		http.NotFound(w, r)
		return
	}
	format := detectFormat(r)
	if format == "html" {
		a.renderSubPage(w, r, s, used, s.Total, expire, reason)
		return
	}
	w.Header().Set("subscription-userinfo", fmt.Sprintf("upload=%d; download=%d; total=%d; expire=%d", up, down, s.Total, expire))
	w.Header().Set("profile-update-interval", "12")
	if s.URL != "" {
		w.Header().Set("profile-web-page-url", s.URL+"?format=html")
	}
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(s.Name))
	switch format {
	case "clash":
		w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
		io.WriteString(w, s.Clash)
	case "singbox":
		if s.Singbox == "" {
			http.Error(w, "该订阅还没有 sing-box 格式，请在 NodeDeck 里同步一次", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		io.WriteString(w, s.Singbox)
	default:
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, s.V2ray)
	}
}

type statsResp struct {
	Version  string              `json:"version"`
	Traffic  map[string]*Traffic `json:"traffic"`
	Disabled map[string]string   `json:"disabled"`
	Uptime   int64               `json:"uptime"`
	LastErr  string              `json:"lastErr"`
	Singbox  UpdateState         `json:"singbox"`
	// 0.3.0 起
	LastActive  map[string]int64 `json:"lastActive"`
	FirstUsed   map[string]int64 `json:"firstUsed"`
	PeriodStart map[string]int64 `json:"periodStart"`
	Today       DayStat          `json:"today"`
	Yesterday   DayStat          `json:"yesterday"`
}

func (a *Agent) handleAdmin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/admin/stats":
		a.mu.Lock()
		resp := statsResp{Version: version, Traffic: a.traffic, Disabled: a.disabled, Uptime: int64(time.Since(a.started).Seconds()), LastErr: a.lastErr, Singbox: a.update,
			LastActive: a.st.LastActive, FirstUsed: a.st.FirstUsed, PeriodStart: a.st.PeriodStart, Today: a.st.Day, Yesterday: a.st.Yesterday}
		b, _ := json.Marshal(resp)
		a.mu.Unlock()
		w.Write(b)
	case "/admin/apply":
		a.loadData()
		if err := a.apply(true); err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	case "/admin/update-singbox":
		msg, err := a.updateSingbox()
		if err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"message": msg})
	case "/admin/metrics":
		json.NewEncoder(w).Encode(a.metricsFor(r.URL.Query().Get("range")))
	case "/admin/notify-test":
		err := a.sendTG(fmt.Sprintf("【%s】✅ NodeDeck 通知测试成功", a.serverName()))
		if err != nil {
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	case "/admin/reset":
		user := r.URL.Query().Get("user")
		a.mu.Lock()
		if user == "" || user == "*" {
			a.traffic = map[string]*Traffic{}
		} else {
			delete(a.traffic, user)
		}
		a.dirty = true
		a.mu.Unlock()
		a.saveTraffic()
		_ = a.apply(false)
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	default:
		http.NotFound(w, r)
	}
}

func loadConfig(path string) Config {
	cfg := Config{StatsAPI: "127.0.0.1:9092", SubListen: ":2096", AdminListen: "127.0.0.1:9091", DataDir: "/etc/nodedeck", SingBox: "/usr/local/bin/sing-box", Service: "nodedeck-singbox"}
	if err := readJSON(path, &cfg); err != nil {
		log.Fatalf("读取配置 %s 失败: %v", path, err)
	}
	return cfg
}

func run(cfgPath string) {
	a := &Agent{cfg: loadConfig(cfgPath), disabled: map[string]string{}, started: time.Now()}
	a.loadTraffic()
	a.loadState()
	a.loadData()
	a.applyHops()
	a.loadMetrics()
	go a.metricsLoop()
	if err := a.apply(true); err != nil {
		log.Printf("启动时应用配置失败: %v", err)
	}

	pub := http.NewServeMux()
	pub.HandleFunc("/sub/", a.handleSub)
	pub.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	go func() {
		log.Fatal((&http.Server{Addr: a.cfg.SubListen, Handler: pub, ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
	}()

	adm := http.NewServeMux()
	adm.HandleFunc("/admin/", a.handleAdmin)
	go func() { log.Fatal(http.ListenAndServe(a.cfg.AdminListen, adm)) }()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, os.Interrupt, syscall.SIGHUP)
	pollT := time.NewTicker(5 * time.Second)
	enforceT := time.NewTicker(15 * time.Second)
	saveT := time.NewTicker(30 * time.Second)
	a.update.Current = singboxVersion(a.cfg.SingBox)
	go a.updateLoop()
	log.Printf("NodeDeck agent %s 已启动，订阅端口 %s", version, a.cfg.SubListen)
	for {
		select {
		case <-pollT.C:
			a.poll()
		case <-enforceT.C:
			if err := a.apply(false); err != nil {
				log.Printf("应用配置失败: %v", err)
			}
		case <-saveT.C:
			a.saveTraffic()
		case s := <-sigs:
			if s == syscall.SIGHUP {
				a.loadData()
				_ = a.apply(true)
				continue
			}
			a.poll()
			a.mu.Lock()
			a.dirty = true
			a.mu.Unlock()
			a.saveTraffic()
			a.saveMetrics()
			return
		}
	}
}

func adminCall(cfgPath, p string) {
	cfg := loadConfig(cfgPath)
	method := "GET"
	if p != "/admin/stats" && !strings.HasPrefix(p, "/admin/metrics") {
		method = "POST"
	}
	req, _ := http.NewRequest(method, "http://"+cfg.AdminListen+p, nil)
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		fmt.Fprintln(os.Stderr, "无法连接 agent:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	os.Stdout.Write(bytes.TrimSpace(b))
	fmt.Println()
	if resp.StatusCode != 200 {
		os.Exit(1)
	}
}

func genCert(host, dir string) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: host},
		DNSNames:              []string{host},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tpl, &tpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644)
	os.WriteFile(filepath.Join(dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0600)
	fmt.Println("ok")
}

func main() {
	log.SetFlags(log.LstdFlags)
	if len(os.Args) < 2 {
		fmt.Println("用法: nodedeck-agent run|stats|metrics|apply|reset [user]|update-singbox|install-singbox|warp-register|scan-reality|apply-hops|notify-test|gencert|version  [-c /etc/nodedeck/agent.json]")
		os.Exit(2)
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("c", "/etc/nodedeck/agent.json", "agent 配置文件")
	host := fs.String("host", "www.bing.com", "证书域名")
	dir := fs.String("dir", "/etc/nodedeck", "证书目录")
	manifest := fs.String("manifest", "", "sing-box manifest.json 地址")
	bin := fs.String("bin", "/usr/local/bin/nodedeck-sing-box", "sing-box 安装路径")
	out := fs.String("out", "/etc/nodedeck/warp.json", "WARP 账号保存位置")
	force := fs.Bool("force", false, "重新注册 WARP")
	warpURL := fs.String("api", warpAPI, "WARP 注册接口")
	rng := fs.String("range", "24h", "监控数据范围：1h / 24h / 7d / 30d")
	selfIP := fs.String("ip", "", "本机公网 IPv4（扫描 Reality 目标用）")
	timeout := fs.Duration("timeout", 2*time.Second, "单个地址的超时")
	fs.Parse(os.Args[2:])
	switch cmd {
	case "run":
		run(*cfgPath)
	case "stats":
		adminCall(*cfgPath, "/admin/stats")
	case "apply":
		adminCall(*cfgPath, "/admin/apply")
	case "reset":
		user := fs.Arg(0)
		adminCall(*cfgPath, "/admin/reset?user="+user)
	case "metrics":
		adminCall(*cfgPath, "/admin/metrics?range="+*rng)
	case "scan-reality":
		scanRealityCmd(*selfIP, *timeout)
	case "warp-register":
		warpRegisterCmd(*out, *force, *warpURL)
	case "apply-hops":
		a := &Agent{cfg: loadConfig(*cfgPath)}
		a.applyHops()
		fmt.Println("ok")
	case "install-singbox":
		v, err := installSingbox(*manifest, *bin)
		if err != nil {
			fmt.Fprintln(os.Stderr, "安装 sing-box 失败:", err)
			os.Exit(1)
		}
		fmt.Println("sing-box", v)
	case "update-singbox":
		adminCall(*cfgPath, "/admin/update-singbox")
	case "notify-test":
		adminCall(*cfgPath, "/admin/notify-test")
	case "gencert":
		genCert(*host, *dir)
	case "version":
		fmt.Println(version)
	default:
		fmt.Println("未知命令:", cmd)
		os.Exit(2)
	}
}
