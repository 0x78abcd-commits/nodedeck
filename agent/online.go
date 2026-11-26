package main

// 在用设备数：读 sing-box / Xray 的连接日志，记下每个用户最近 10 分钟连进来的不同来源 IP。
// 做法参考 3x-ui 的「IP 限制」（读 Xray 访问日志按 email 统计来源 IP）。
//   - sing-box 每条连接先打一行「inbound connection from IP」，认证后同一个连接 ID 再打一行「[用户] inbound connection to 目标」
//   - Xray 访问日志一行就有「from IP accepted … email: 用户」
// 日志文件每 15 秒读一次就清空，只留来源 IP 和时间，不记访问的网站。sing-box 的警告和错误转写到 agent 自己的日志里。
import (
	"bytes"
	"io"
	"log"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	onlineWindow  = 10 * 60 // 秒：这段时间里连过的 IP 算在用
	connLogMax    = 64 << 20
	pendingExpire = 60
)

type onlineTracker struct {
	mu   sync.Mutex
	ips  map[string]map[string]int64 // 用户 → IP → 最后一次连接
	pend map[string]pendConn         // sing-box 连接 ID → 来源（等认证那一行）
}

type pendConn struct {
	ip string
	at int64
}

var (
	sbFromRe   = regexp.MustCompile(`^\w+ \[(\d+) [^\]]*\] inbound/[^:]+: (?:\[([^\]]+)\] )?inbound (?:packet )?connection from (\S+)`)
	sbUserRe   = regexp.MustCompile(`^\w+ \[(\d+) [^\]]*\] inbound/[^:]+: \[([^\]]+)\] inbound (?:packet )?connection to `)
	xrAccessRe = regexp.MustCompile(`from (?:tcp:|udp:)?(\S+) accepted .*email: (\S+)`)
)

func newOnlineTracker() *onlineTracker {
	return &onlineTracker{ips: map[string]map[string]int64{}, pend: map[string]pendConn{}}
}

// hostOnly 去掉端口，处理 [v6]:port 和 v4:port
func hostOnly(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		addr = h
	}
	return strings.Trim(addr, "[]")
}

func skipSource(ip string) bool {
	p := net.ParseIP(ip)
	return p == nil || p.IsLoopback() || p.IsUnspecified()
}

func (o *onlineTracker) see(user, ip string, now int64) {
	if user == "" || skipSource(ip) {
		return
	}
	m := o.ips[user]
	if m == nil {
		m = map[string]int64{}
		o.ips[user] = m
	}
	m[ip] = now
}

// feedSingbox 解析一段 sing-box 日志；返回其中的警告 / 错误行
func (o *onlineTracker) feedSingbox(data []byte, now int64) (warn []string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		s := string(bytes.TrimSpace(line))
		if s == "" {
			continue
		}
		if !strings.HasPrefix(s, "INFO") && !strings.HasPrefix(s, "DEBUG") && !strings.HasPrefix(s, "TRACE") {
			warn = append(warn, s)
			continue
		}
		if m := sbFromRe.FindStringSubmatch(s); m != nil {
			ip := hostOnly(m[3])
			if m[2] != "" { // 像 Shadowsocks UDP 这样一行里就有用户
				o.see(m[2], ip, now)
				continue
			}
			o.pend[m[1]] = pendConn{ip: ip, at: now}
			continue
		}
		if m := sbUserRe.FindStringSubmatch(s); m != nil {
			if p, ok := o.pend[m[1]]; ok {
				o.see(m[2], p.ip, now)
				delete(o.pend, m[1])
			}
		}
	}
	for id, p := range o.pend {
		if now-p.at > pendingExpire {
			delete(o.pend, id)
		}
	}
	return
}

func (o *onlineTracker) feedXray(data []byte, now int64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if m := xrAccessRe.FindSubmatch(line); m != nil {
			o.see(string(m[2]), hostOnly(string(m[1])), now)
		}
	}
}

// snapshot 每个用户最近 10 分钟的来源 IP（按最近使用排序），顺便清掉过期的
func (o *onlineTracker) snapshot(now int64) map[string][]string {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := map[string][]string{}
	for u, m := range o.ips {
		type kv struct {
			ip string
			t  int64
		}
		var list []kv
		for ip, t := range m {
			if now-t > onlineWindow {
				delete(m, ip)
				continue
			}
			list = append(list, kv{ip, t})
		}
		if len(m) == 0 {
			delete(o.ips, u)
			continue
		}
		sort.Slice(list, func(i, j int) bool { return list[i].t > list[j].t })
		for _, x := range list {
			out[u] = append(out[u], x.ip)
		}
	}
	return out
}

// drainFile 读出文件里的全部内容并清空（写入方用追加模式打开，清空后接着从头写）。太大就直接清空。
func drainFile(path string) []byte {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return nil
	}
	var data []byte
	if st.Size() <= connLogMax {
		data, _ = io.ReadAll(io.LimitReader(f, connLogMax))
	}
	_ = f.Truncate(0)
	return data
}

func (a *Agent) onlineLoop() {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		now := time.Now().Unix()
		a.mu.Lock()
		sbLog, xrLog := a.cfg.ConnLog, a.cfg.XrayAccessLog
		a.mu.Unlock()
		if sbLog != "" {
			for _, w := range a.online.feedSingbox(drainFile(sbLog), now) {
				log.Printf("sing-box: %s", w)
			}
		}
		if xrLog != "" {
			a.online.feedXray(drainFile(xrLog), now)
		}
		<-t.C
	}
}
