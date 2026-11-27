package main

// 桌面端测速：从 VPS 下载 / 往 VPS 上传一段数据测 TCP 实际速度；UDP 回显测丢包和抖动。
// 都要带测速口令（只有 NodeDeck 知道），防止别人拿来刷流量。
import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

var speedBuf = func() []byte {
	b := make([]byte, 1<<20)
	_, _ = rand.Read(b) // 随机数据，避免被压缩
	return b
}()

var speedActive int32

const speedMaxBytes = 256 << 20

func (a *Agent) speedTokenOK(t string) bool {
	tok := a.cfg.SpeedToken
	return len(tok) >= 16 && subtle.ConstantTimeCompare([]byte(t), []byte(tok)) == 1
}

func (a *Agent) handleSpeed(w http.ResponseWriter, r *http.Request) {
	if !a.speedTokenOK(r.URL.Query().Get("t")) {
		http.NotFound(w, r)
		return
	}
	if atomic.AddInt32(&speedActive, 1) > 8 {
		atomic.AddInt32(&speedActive, -1)
		http.Error(w, "busy", http.StatusTooManyRequests)
		return
	}
	defer atomic.AddInt32(&speedActive, -1)
	switch r.URL.Path {
	case "/nd-speed/down":
		n, _ := strconv.ParseInt(r.URL.Query().Get("bytes"), 10, 64)
		if n <= 0 || n > speedMaxBytes {
			n = 32 << 20
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatInt(n, 10))
		w.Header().Set("Cache-Control", "no-store")
		for n > 0 {
			c := int64(len(speedBuf))
			if n < c {
				c = n
			}
			if _, err := w.Write(speedBuf[:c]); err != nil {
				return
			}
			n -= c
		}
	case "/nd-speed/up":
		// 从收到第一个字节起算，跳过前 1 秒（TCP 慢启动），之后的字节数 / 时间才是稳定速度
		t0 := time.Now()
		buf := make([]byte, 64<<10)
		body := io.LimitReader(r.Body, speedMaxBytes)
		var got, markBytes int64
		var first, mark time.Time
		for {
			n, err := body.Read(buf)
			if n > 0 {
				now := time.Now()
				if first.IsZero() {
					first = now
				}
				got += int64(n)
				if mark.IsZero() && now.Sub(first) >= time.Second {
					mark, markBytes = now, got
				}
			}
			if err != nil {
				break
			}
		}
		res := map[string]int64{"bytes": got, "ms": time.Since(t0).Milliseconds()}
		if !mark.IsZero() {
			res["steadyBytes"] = got - markBytes
			res["steadyMs"] = time.Since(mark).Milliseconds()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(res)
	case "/nd-speed/ping":
		w.Write([]byte("ok"))
	case "/nd-speed/tcping":
		// 被墙检测用：从这台 VPS 连一下别的服务器的端口（自己的服务器互相检测，不用第三方）。只许连公网地址
		host := r.URL.Query().Get("host")
		port, _ := strconv.Atoi(r.URL.Query().Get("port"))
		w.Header().Set("Content-Type", "application/json")
		res := map[string]any{"ok": false}
		if host == "" || port <= 0 || port > 65535 {
			res["error"] = "地址或端口不对"
		} else if ips, err := net.LookupIP(host); err != nil || len(ips) == 0 {
			res["error"] = "解析不了域名"
		} else if ip := ips[0]; !publicIP(ip) {
			res["error"] = "不检测内网地址"
		} else {
			t0 := time.Now()
			c, err := net.DialTimeout("tcp", net.JoinHostPort(ip.String(), strconv.Itoa(port)), 5*time.Second)
			if err != nil {
				res["error"] = err.Error()
			} else {
				c.Close()
				res["ok"] = true
				res["ms"] = time.Since(t0).Milliseconds()
			}
		}
		_ = json.NewEncoder(w).Encode(res)
	case "/nd-speed/ip":
		// 节点测试查出口 IP：请求经节点发到这台 VPS 自己，看到的来源就是节点的出口（走落地时是落地的 IP），不经第三方
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"ip": host})
	default:
		http.NotFound(w, r)
	}
}

// udpEcho 在订阅端口的 UDP 上回显带口令的小包（原样返回，不放大），每秒最多 2000 个
func (a *Agent) udpEcho() {
	addr := a.cfg.SubListen
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return
	}
	defer pc.Close()
	tok := []byte(a.cfg.SpeedToken)
	if len(tok) > 16 {
		tok = tok[:16]
	}
	buf := make([]byte, 2048)
	var count int
	win := time.Now()
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if len(tok) < 16 || n < 16 || subtle.ConstantTimeCompare(buf[:16], tok) != 1 {
			continue
		}
		if time.Since(win) > time.Second {
			win, count = time.Now(), 0
		}
		if count++; count > 2000 {
			continue
		}
		_, _ = pc.WriteTo(buf[:n], from)
	}
}

// 公网地址才让 tcping 去连：排除本机、内网、链路本地（含云厂商元数据 169.254.169.254）、组播、运营商级 NAT（100.64/10）、0.0.0.0/8 等
var nonPublicNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, c := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15", "240.0.0.0/4", "64:ff9b::/96", "2001:db8::/32"} {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

func publicIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	for _, n := range nonPublicNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}
