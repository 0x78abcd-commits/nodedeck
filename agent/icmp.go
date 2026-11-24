package main

// ICMP 测量：ping（延迟 / 丢包 / 抖动）和路由追踪（回程线路识别）。用原始套接字，需要 root（agent 本来就是 root）。
import (
	"encoding/binary"
	"errors"
	"math"
	"math/rand"
	"net"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

func icmpChecksum(b []byte) uint16 {
	var s uint32
	for i := 0; i+1 < len(b); i += 2 {
		s += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		s += uint32(b[len(b)-1]) << 8
	}
	for s>>16 != 0 {
		s = (s & 0xffff) + (s >> 16)
	}
	return ^uint16(s)
}

func echoPacket(id, seq uint16, size int) []byte {
	if size < 16 {
		size = 16
	}
	b := make([]byte, 8+size)
	b[0] = 8 // echo request
	binary.BigEndian.PutUint16(b[4:], id)
	binary.BigEndian.PutUint16(b[6:], seq)
	copy(b[8:], "nodedeck")
	binary.BigEndian.PutUint16(b[2:], icmpChecksum(b))
	return b
}

type icmpReply struct {
	from  string
	typ   byte
	id    uint16
	seq   uint16
	at    time.Time
	final bool // 到达目标（echo reply）
}

// parseICMP 解析收到的 ICMP（Go 的 ip4:icmp 连接读出来的数据不含 IP 头）
func parseICMP(b []byte) (typ byte, id, seq uint16, ok bool) {
	if len(b) < 8 {
		return
	}
	typ = b[0]
	switch typ {
	case 0: // echo reply
		return typ, binary.BigEndian.Uint16(b[4:]), binary.BigEndian.Uint16(b[6:]), true
	case 11, 3: // time exceeded / unreachable：后面带原始 IP 头 + 原始 ICMP 头
		in := b[8:]
		if len(in) < 20 {
			return
		}
		ihl := int(in[0]&0x0f) * 4
		if len(in) < ihl+8 || in[9] != 1 {
			return
		}
		o := in[ihl:]
		if o[0] != 8 {
			return
		}
		return typ, binary.BigEndian.Uint16(o[4:]), binary.BigEndian.Uint16(o[6:]), true
	}
	return
}

type icmpConn struct {
	c   *net.IPConn
	raw syscall.RawConn
}

func openICMP() (*icmpConn, error) {
	pc, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return nil, err
	}
	c := pc.(*net.IPConn)
	raw, err := c.SyscallConn()
	if err != nil {
		c.Close()
		return nil, err
	}
	return &icmpConn{c: c, raw: raw}, nil
}

func (ic *icmpConn) setTTL(ttl int) {
	_ = ic.raw.Control(func(fd uintptr) { _ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_TTL, ttl) })
}

// read 在 deadline 前读取匹配 id 的回复
func (ic *icmpConn) readLoop(id uint16, deadline time.Time, fn func(r icmpReply) bool) {
	buf := make([]byte, 1500)
	for {
		_ = ic.c.SetReadDeadline(deadline)
		n, addr, err := ic.c.ReadFrom(buf)
		if err != nil {
			return
		}
		typ, rid, seq, ok := parseICMP(buf[:n])
		if !ok || rid != id {
			continue
		}
		if fn(icmpReply{from: addr.String(), typ: typ, id: rid, seq: seq, at: time.Now(), final: typ == 0}) {
			return
		}
	}
}

func resolve4(host string) (net.IP, error) {
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		return ip.To4(), nil
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if ip.To4() != nil {
			return ip.To4(), nil
		}
	}
	return nil, errors.New("没有 IPv4 地址")
}

type PingResult struct {
	Host   string  `json:"host"`
	Sent   int     `json:"sent"`
	Recv   int     `json:"recv"`
	Loss   float64 `json:"loss"`   // %
	Avg    float64 `json:"avg"`    // ms
	Min    float64 `json:"min"`    // ms
	Max    float64 `json:"max"`    // ms
	Jitter float64 `json:"jitter"` // ms，相邻两次延迟差的平均值
	Error  string  `json:"error,omitempty"`
}

var icmpID uint32 = uint32(rand.Intn(0xffff))
var icmpIDMu sync.Mutex

func nextICMPID() uint16 {
	icmpIDMu.Lock()
	defer icmpIDMu.Unlock()
	icmpID = (icmpID + 1) & 0xffff
	return uint16(icmpID)
}

// icmpPing 发 count 个包（间隔 interval），统计丢包、延迟、抖动
func icmpPing(host string, count int, interval, timeout time.Duration) PingResult {
	r := PingResult{Host: host, Sent: count}
	ip, err := resolve4(host)
	if err != nil {
		r.Error, r.Loss = err.Error(), 100
		return r
	}
	ic, err := openICMP()
	if err != nil {
		r.Error, r.Loss = err.Error(), 100
		return r
	}
	defer ic.c.Close()
	ic.setTTL(64)
	id := nextICMPID()
	sent := make([]time.Time, count)
	rtts := make([]float64, count)
	for i := range rtts {
		rtts[i] = -1
	}
	var mu sync.Mutex
	done := make(chan struct{})
	go func() {
		ic.readLoop(id, time.Now().Add(time.Duration(count)*interval+timeout), func(rp icmpReply) bool {
			if !rp.final || int(rp.seq) >= count {
				return false
			}
			mu.Lock()
			if rtts[rp.seq] < 0 && !sent[rp.seq].IsZero() {
				rtts[rp.seq] = float64(rp.at.Sub(sent[rp.seq]).Microseconds()) / 1000
			}
			got := 0
			for _, v := range rtts {
				if v >= 0 {
					got++
				}
			}
			mu.Unlock()
			return got == count
		})
		close(done)
	}()
	for i := 0; i < count; i++ {
		mu.Lock()
		sent[i] = time.Now()
		mu.Unlock()
		_, _ = ic.c.WriteTo(echoPacket(id, uint16(i), 32), &net.IPAddr{IP: ip})
		if i < count-1 {
			time.Sleep(interval)
		}
	}
	<-done
	var ok []float64
	prev := -1.0
	var jsum float64
	jn := 0
	for _, v := range rtts {
		if v < 0 {
			continue
		}
		ok = append(ok, v)
		if prev >= 0 {
			jsum += math.Abs(v - prev)
			jn++
		}
		prev = v
	}
	r.Recv = len(ok)
	r.Loss = 100 * float64(count-r.Recv) / float64(count)
	if len(ok) > 0 {
		sort.Float64s(ok)
		r.Min, r.Max = ok[0], ok[len(ok)-1]
		var s float64
		for _, v := range ok {
			s += v
		}
		r.Avg = s / float64(len(ok))
	}
	if jn > 0 {
		r.Jitter = jsum / float64(jn)
	}
	return r
}

type Hop struct {
	TTL int     `json:"ttl"`
	IP  string  `json:"ip"`
	Ms  float64 `json:"ms"`
}

type TraceResult struct {
	Name    string `json:"name"`
	Target  string `json:"target"`
	Hops    []Hop  `json:"hops"`
	Reached bool   `json:"reached"`
	Line    string `json:"line"`    // 识别出的线路
	LineTip string `json:"lineTip"` // 线路说明
	Error   string `json:"error,omitempty"`
}

// traceICMP 一次把 1~maxHops 的探测包全发出去，等回复；没回的再补一轮。比逐跳等待快很多
func traceICMP(host string, maxHops int) TraceResult {
	tr := TraceResult{Target: host}
	ip, err := resolve4(host)
	if err != nil {
		tr.Error = err.Error()
		return tr
	}
	ic, err := openICMP()
	if err != nil {
		tr.Error = err.Error()
		return tr
	}
	defer ic.c.Close()
	id := nextICMPID()
	hops := make([]Hop, maxHops+1)
	sentAt := map[uint16]time.Time{}
	var mu sync.Mutex
	destTTL := 0
	for round := 0; round < 3; round++ {
		done := make(chan struct{})
		go func() {
			ic.readLoop(id, time.Now().Add(2500*time.Millisecond), func(rp icmpReply) bool {
				ttl := int(rp.seq) % 100
				if ttl < 1 || ttl > maxHops {
					return false
				}
				mu.Lock()
				defer mu.Unlock()
				if hops[ttl].IP == "" {
					hops[ttl] = Hop{TTL: ttl, IP: rp.from, Ms: float64(rp.at.Sub(sentAt[rp.seq]).Microseconds()) / 1000}
				}
				if rp.final && (destTTL == 0 || ttl < destTTL) {
					destTTL = ttl
				}
				return false
			})
			close(done)
		}()
		for ttl := 1; ttl <= maxHops; ttl++ {
			mu.Lock()
			skip := hops[ttl].IP != "" || (destTTL > 0 && ttl > destTTL)
			seq := uint16(round*100 + ttl)
			if !skip {
				sentAt[seq] = time.Now()
			}
			mu.Unlock()
			if skip {
				continue
			}
			ic.setTTL(ttl)
			_, _ = ic.c.WriteTo(echoPacket(id, seq, 32), &net.IPAddr{IP: ip})
			time.Sleep(3 * time.Millisecond)
		}
		<-done
		mu.Lock()
		missing := 0
		last := maxHops
		if destTTL > 0 {
			last = destTTL
		}
		for t := 1; t <= last; t++ {
			if hops[t].IP == "" {
				missing++
			}
		}
		mu.Unlock()
		if missing == 0 {
			break
		}
	}
	last := maxHops
	if destTTL > 0 {
		last = destTTL
		tr.Reached = true
	} else {
		for last > 0 && hops[last].IP == "" {
			last--
		}
	}
	for t := 1; t <= last; t++ {
		h := hops[t]
		h.TTL = t
		if h.IP == "" {
			h.IP = "*"
		}
		tr.Hops = append(tr.Hops, h)
	}
	tr.Line, tr.LineTip = classifyRoute(tr.Hops)
	return tr
}

// classifyRoute 按经过的骨干网地址段判断线路（和常见回程测试脚本的判断方法一样）
func classifyRoute(hops []Hop) (string, string) {
	has := func(prefixes ...string) bool {
		for _, h := range hops {
			for _, p := range prefixes {
				if strings.HasPrefix(h.IP, p) {
					return true
				}
			}
		}
		return false
	}
	cn2 := has("59.43.")
	p163 := has("202.97.")
	switch {
	case cn2 && !p163:
		return "CN2 GIA", "电信最高端的国际线路，晚高峰也稳"
	case cn2 && p163:
		return "CN2 GT", "电信次一级的国际线路，出国段走 163，晚高峰一般"
	case has("218.105.", "210.51."):
		return "联通 9929", "联通精品网（CUII），质量好"
	case has("218.110.", "43.252.86."):
		return "联通 10099", "联通国际（CUG），质量较好"
	case has("223.120.", "223.121.", "223.118.", "223.119."):
		return "移动 CMI / CMIN2", "移动国际线路"
	case p163:
		return "电信 163", "电信普通国际线路，晚高峰容易拥堵"
	case has("219.158."):
		return "联通 4837", "联通普通国际线路，晚高峰容易拥堵"
	case has("221.183.", "221.176.", "111.24."):
		return "移动 CMNET", "移动普通骨干网"
	}
	return "未识别", "路径里没有看到常见的骨干网地址（可能中间节点不回应）"
}

// 三网回程测试目标（北京 / 上海 / 广州），回程测试脚本常用的地址
var traceTargets = []struct{ Name, IP string }{
	{"北京电信", "219.141.140.10"}, {"北京联通", "202.106.195.68"}, {"北京移动", "221.179.155.161"},
	{"上海电信", "202.96.209.133"}, {"上海联通", "210.22.97.1"}, {"上海移动", "211.136.112.200"},
	{"广州电信", "58.60.188.222"}, {"广州联通", "210.21.196.6"}, {"广州移动", "120.196.165.24"},
}

func traceAll() []TraceResult {
	out := make([]TraceResult, len(traceTargets))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for i, t := range traceTargets {
		wg.Add(1)
		go func(i int, name, ip string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			r := traceICMP(ip, 30)
			r.Name = name
			out[i] = r
		}(i, t.Name, t.IP)
	}
	wg.Wait()
	return out
}

// pathMTU 探测到 host 的路径 MTU：禁止分片发不同大小的 ping，二分找到能通的最大包
func pathMTU(host string) (int, error) {
	ip, err := resolve4(host)
	if err != nil {
		return 0, err
	}
	ic, err := openICMP()
	if err != nil {
		return 0, err
	}
	defer ic.c.Close()
	ic.setTTL(64)
	_ = ic.raw.Control(func(fd uintptr) {
		_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_MTU_DISCOVER, syscall.IP_PMTUDISC_PROBE)
	})
	id := nextICMPID()
	try := func(size int, seq uint16) bool {
		for k := 0; k < 2; k++ {
			s := seq + uint16(k)*1000
			if _, err := ic.c.WriteTo(echoPacket(id, s, size-28-8+8), &net.IPAddr{IP: ip}); err != nil {
				return false
			}
			got := false
			ic.readLoop(id, time.Now().Add(1200*time.Millisecond), func(r icmpReply) bool {
				if r.final && r.seq == s {
					got = true
					return true
				}
				return false
			})
			if got {
				return true
			}
		}
		return false
	}
	// size 是 IP 包总大小
	if !try(576, 1) {
		return 0, errors.New("目标不回应 ping，测不了")
	}
	lo, hi := 576, 1500
	seq := uint16(2)
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if try(mid, seq) {
			lo = mid
		} else {
			hi = mid - 1
		}
		seq++
	}
	return lo, nil
}
