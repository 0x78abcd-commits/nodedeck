package main

// 端口转发（中转）：agent 自己监听端口，把 TCP / UDP 转到目标。参考 realm、gost 这类转发工具：
//   - 多个目标：主备（第一个连不上换下一个）或轮询，定时探测每个目标通不通、延迟多少
//   - 每条规则统计流量和当前连接数；可以只允许指定来源 IP 使用
//   - TCP 用 io.CopyN 分段转发：Linux 上两头都是 TCP 时走 splice（内核里直接搬数据），又能按段累计流量
// 以前转发由 sing-box 的 direct 入站做，没有流量统计和多目标。
import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type FwdRule struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Listen   int      `json:"listen"`
	Network  string   `json:"network"`  // tcp / udp / 空 = 两种都转
	Targets  []string `json:"targets"`  // host:port，按顺序
	Strategy string   `json:"strategy"` // failover（默认，主备）/ roundrobin（轮询）
	Allow    []string `json:"allow"`    // 允许的来源 IP 或网段；空 = 不限
}

type fwdTarget struct {
	Addr  string  `json:"addr"`
	OK    bool    `json:"ok"`
	Ms    float64 `json:"ms"`
	Error string  `json:"error,omitempty"`
	At    int64   `json:"at"`
}

type fwdRuntime struct {
	rule    FwdRule
	allow   []*net.IPNet
	up      atomic.Int64 // 用户 → 目标
	down    atomic.Int64 // 目标 → 用户
	conns   atomic.Int64
	total   atomic.Int64 // 累计连接数
	rr      atomic.Uint64
	mu      sync.Mutex
	targets []fwdTarget
	err     string // 监听失败等
	closers []io.Closer
	stopped atomic.Bool
}

type fwdManager struct {
	mu    sync.Mutex
	rules map[string]*fwdRuntime
	saved map[string][2]int64 // 重启前累计的流量
	path  string
}

type FwdStatus struct {
	Up      int64       `json:"up"`
	Down    int64       `json:"down"`
	Conns   int64       `json:"conns"`
	Total   int64       `json:"total"`
	Error   string      `json:"error,omitempty"`
	Targets []fwdTarget `json:"targets"`
}

func parseAllow(list []string) []*net.IPNet {
	var out []*net.IPNet
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if !strings.Contains(s, "/") {
			if ip := net.ParseIP(s); ip != nil {
				if ip.To4() != nil {
					s += "/32"
				} else {
					s += "/128"
				}
			}
		}
		if _, n, err := net.ParseCIDR(s); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func (r *fwdRuntime) allowed(addr net.Addr) bool {
	if len(r.allow) == 0 {
		return true
	}
	ip := net.ParseIP(hostOnly(addr.String()))
	for _, n := range r.allow {
		if ip != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// order 这次连接按什么顺序试目标：轮询从下一个开始；主备从第一个开始。探测不通的放到最后
func (r *fwdRuntime) order() []string {
	t := r.rule.Targets
	n := len(t)
	start := 0
	if r.rule.Strategy == "roundrobin" && n > 1 {
		start = int(r.rr.Add(1) % uint64(n))
	}
	r.mu.Lock()
	bad := map[string]bool{}
	for _, x := range r.targets {
		if x.At > 0 && !x.OK {
			bad[x.Addr] = true
		}
	}
	r.mu.Unlock()
	var good, rest []string
	for i := 0; i < n; i++ {
		a := t[(start+i)%n]
		if bad[a] {
			rest = append(rest, a)
		} else {
			good = append(good, a)
		}
	}
	return append(good, rest...)
}

// pipe 单向转发，按 4MB 一段累计流量
func pipe(dst, src net.Conn, counter *atomic.Int64) {
	for {
		n, err := io.CopyN(dst, src, 4<<20)
		counter.Add(n)
		if err != nil {
			break
		}
	}
	if c, ok := dst.(*net.TCPConn); ok {
		_ = c.CloseWrite()
	}
}

func (r *fwdRuntime) serveTCP(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			if r.stopped.Load() {
				return
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if !r.allowed(c.RemoteAddr()) {
			c.Close()
			continue
		}
		go r.handleTCP(c)
	}
}

func (r *fwdRuntime) handleTCP(c net.Conn) {
	defer c.Close()
	var up net.Conn
	var err error
	for _, t := range r.order() {
		up, err = net.DialTimeout("tcp", t, 5*time.Second)
		if err == nil {
			break
		}
		r.markTarget(t, false, 0, err)
	}
	if up == nil {
		return
	}
	defer up.Close()
	r.conns.Add(1)
	r.total.Add(1)
	defer r.conns.Add(-1)
	done := make(chan struct{})
	go func() { pipe(up, c, &r.up); close(done) }()
	pipe(c, up, &r.down)
	<-done
}

// UDP：每个来源地址一个到目标的连接，60 秒没包就关掉
func (r *fwdRuntime) serveUDP(pc net.PacketConn) {
	type sess struct {
		up   net.Conn
		last atomic.Int64
	}
	var mu sync.Mutex
	sessions := map[string]*sess{}
	go func() {
		for !r.stopped.Load() {
			time.Sleep(15 * time.Second)
			now := time.Now().Unix()
			mu.Lock()
			for k, s := range sessions {
				if now-s.last.Load() > 60 {
					s.up.Close()
					delete(sessions, k)
				}
			}
			mu.Unlock()
		}
	}()
	buf := make([]byte, 65535)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			if r.stopped.Load() {
				mu.Lock()
				for _, s := range sessions {
					s.up.Close()
				}
				mu.Unlock()
				return
			}
			continue
		}
		if !r.allowed(from) {
			continue
		}
		key := from.String()
		mu.Lock()
		s := sessions[key]
		if s == nil {
			var up net.Conn
			for _, t := range r.order() {
				if up, err = net.Dial("udp", t); err == nil {
					break
				}
			}
			if up == nil {
				mu.Unlock()
				continue
			}
			s = &sess{up: up}
			sessions[key] = s
			r.conns.Add(1)
			r.total.Add(1)
			go func(s *sess, from net.Addr) {
				defer r.conns.Add(-1)
				b := make([]byte, 65535)
				for {
					m, err := s.up.Read(b)
					if err != nil {
						return
					}
					s.last.Store(time.Now().Unix())
					r.down.Add(int64(m))
					_, _ = pc.WriteTo(b[:m], from)
				}
			}(s, from)
		}
		mu.Unlock()
		s.last.Store(time.Now().Unix())
		if m, err := s.up.Write(buf[:n]); err == nil {
			r.up.Add(int64(m))
		}
	}
}

func (r *fwdRuntime) markTarget(addr string, ok bool, ms float64, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.targets {
		if r.targets[i].Addr == addr {
			r.targets[i].OK, r.targets[i].Ms, r.targets[i].At = ok, ms, time.Now().Unix()
			r.targets[i].Error = ""
			if err != nil {
				r.targets[i].Error = err.Error()
			}
		}
	}
}

// probe 探测每个目标（TCP 连一下）；只转 UDP 的规则测不了，不探测
func (r *fwdRuntime) probe() {
	if r.rule.Network == "udp" {
		return
	}
	for _, t := range r.rule.Targets {
		t0 := time.Now()
		c, err := net.DialTimeout("tcp", t, 5*time.Second)
		if err != nil {
			r.markTarget(t, false, 0, err)
			continue
		}
		c.Close()
		r.markTarget(t, true, float64(time.Since(t0).Microseconds())/1000, nil)
	}
}

// listen 监听端口；端口被占（比如刚从 sing-box 转发切过来，旧进程还没退）就每 5 秒重试
func (r *fwdRuntime) listen() {
	addr := ":" + itoa(r.rule.Listen)
	for !r.stopped.Load() {
		var errs []string
		if r.rule.Network != "udp" && !r.hasTCP() {
			if ln, err := net.Listen("tcp", addr); err == nil {
				r.addCloser(ln, "tcp")
				go r.serveTCP(ln)
			} else {
				errs = append(errs, "TCP "+err.Error())
			}
		}
		if r.rule.Network != "tcp" && !r.hasUDP() {
			if pc, err := net.ListenPacket("udp", addr); err == nil {
				r.addCloser(pc, "udp")
				go r.serveUDP(pc)
			} else {
				errs = append(errs, "UDP "+err.Error())
			}
		}
		r.mu.Lock()
		r.err = strings.Join(errs, "；")
		r.mu.Unlock()
		if len(errs) == 0 {
			return
		}
		time.Sleep(5 * time.Second)
	}
}

func (r *fwdRuntime) addCloser(c io.Closer, kind string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closers = append(r.closers, kindCloser{c, kind})
}

type kindCloser struct {
	io.Closer
	kind string
}

func (r *fwdRuntime) has(kind string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.closers {
		if c.(kindCloser).kind == kind {
			return true
		}
	}
	return false
}
func (r *fwdRuntime) hasTCP() bool { return r.has("tcp") }
func (r *fwdRuntime) hasUDP() bool { return r.has("udp") }

func (r *fwdRuntime) stop() {
	r.stopped.Store(true)
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.closers {
		c.Close()
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func validFwd(r FwdRule) error {
	if r.ID == "" || r.Listen <= 0 || r.Listen > 65535 {
		return errors.New("端口不对")
	}
	if len(r.Targets) == 0 {
		return errors.New("没有目标")
	}
	return nil
}

func newFwdManager(path string) *fwdManager {
	m := &fwdManager{rules: map[string]*fwdRuntime{}, saved: map[string][2]int64{}, path: path}
	_ = readJSON(path, &m.saved)
	return m
}

// apply 按配置启动 / 停止规则；没变的规则不动（连接不断）
func (m *fwdManager) apply(rules []FwdRule) {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := map[string]FwdRule{}
	for _, r := range rules {
		if err := validFwd(r); err != nil {
			log.Printf("转发规则 %s 无效：%v", r.ID, err)
			continue
		}
		want[r.ID] = r
	}
	for id, rt := range m.rules {
		if w, ok := want[id]; !ok || !sameRule(w, rt.rule) {
			m.saved[id] = [2]int64{rt.up.Load(), rt.down.Load()}
			rt.stop()
			delete(m.rules, id)
		}
	}
	for id, r := range want {
		if _, ok := m.rules[id]; ok {
			continue
		}
		rt := &fwdRuntime{rule: r, allow: parseAllow(r.Allow)}
		for _, t := range r.Targets {
			rt.targets = append(rt.targets, fwdTarget{Addr: t})
		}
		if s, ok := m.saved[id]; ok {
			rt.up.Store(s[0])
			rt.down.Store(s[1])
		}
		m.rules[id] = rt
		go rt.listen()
		go rt.probe()
	}
	for id := range m.saved {
		if _, ok := want[id]; !ok {
			delete(m.saved, id) // 删掉的规则不再留流量
		}
	}
}

func sameRule(a, b FwdRule) bool {
	return a.Listen == b.Listen && a.Network == b.Network && a.Strategy == b.Strategy &&
		strings.Join(a.Targets, ",") == strings.Join(b.Targets, ",") && strings.Join(a.Allow, ",") == strings.Join(b.Allow, ",")
}

func (m *fwdManager) save() {
	m.mu.Lock()
	for id, rt := range m.rules {
		m.saved[id] = [2]int64{rt.up.Load(), rt.down.Load()}
	}
	b := m.saved
	m.mu.Unlock()
	if j, err := json.Marshal(b); err == nil {
		_ = writeFileAtomic(m.path, j, 0600)
	}
}

func (m *fwdManager) status() map[string]FwdStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]FwdStatus{}
	for id, rt := range m.rules {
		rt.mu.Lock()
		st := FwdStatus{Up: rt.up.Load(), Down: rt.down.Load(), Conns: rt.conns.Load(), Total: rt.total.Load(), Error: rt.err, Targets: append([]fwdTarget(nil), rt.targets...)}
		rt.mu.Unlock()
		out[id] = st
	}
	return out
}

// reset 清零某条规则的流量
func (m *fwdManager) reset(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rt, ok := m.rules[id]; ok {
		rt.up.Store(0)
		rt.down.Store(0)
		rt.total.Store(0)
	}
	delete(m.saved, id)
}

func (a *Agent) forwardLoop() {
	a.fwd.apply(a.cfg.Forwards)
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	n := 0
	for range t.C {
		a.fwd.mu.Lock()
		rts := make([]*fwdRuntime, 0, len(a.fwd.rules))
		for _, rt := range a.fwd.rules {
			rts = append(rts, rt)
		}
		a.fwd.mu.Unlock()
		for _, rt := range rts {
			go rt.probe()
		}
		if n++; n%10 == 0 { // 每 5 分钟存一次流量
			a.fwd.save()
		}
	}
}
