package main

// 探测一个地址是不是 HTTP / Socks 这类明文代理：端口转发如果把它原样转到公网，就等于对全网开放了一个不安全代理
// （很多服务商明令禁止，IP 也会被滥用、污染）。只做握手层面的试探，不经它访问任何网站：
//   Socks5：发问候（支持「无认证」和「用户名密码」），回 0x05 开头就是
//   Socks4：发一个连到 0.0.0.0 的请求，回 0x00 + 0x5A..0x5D 就是（目标无效，代理不会真的去连）
//   HTTP 代理：发 CONNECT，回 200（开放代理）或 407（要认证的代理）就是；普通网站一般回 400 / 405
import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

type ProxyProbe struct {
	Target string `json:"target"`
	Kind   string `json:"kind"`  // socks5 / socks4 / http；空 = 不是代理
	Error  string `json:"error"` // 连不上等
}

func probeConn(target string, timeout time.Duration, send []byte, read func(c net.Conn) bool) (bool, error) {
	c, err := net.DialTimeout("tcp", target, timeout)
	if err != nil {
		return false, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(timeout))
	if _, err := c.Write(send); err != nil {
		return false, nil
	}
	return read(c), nil
}

func probeProxy(target string, timeout time.Duration) ProxyProbe {
	out := ProxyProbe{Target: target}
	// Socks5
	ok, err := probeConn(target, timeout, []byte{0x05, 0x02, 0x00, 0x02}, func(c net.Conn) bool {
		b := make([]byte, 2)
		n, _ := c.Read(b)
		return n == 2 && b[0] == 0x05 && (b[1] == 0x00 || b[1] == 0x02 || b[1] == 0xFF)
	})
	if err != nil {
		out.Error = err.Error()
		return out
	}
	if ok {
		out.Kind = "socks5"
		return out
	}
	// HTTP 代理
	ok, _ = probeConn(target, timeout, []byte("CONNECT nodedeck-probe.invalid:443 HTTP/1.1\r\nHost: nodedeck-probe.invalid:443\r\n\r\n"), func(c net.Conn) bool {
		line, err := bufio.NewReader(c).ReadString('\n')
		if err != nil && line == "" {
			return false
		}
		f := strings.Fields(line)
		return len(f) >= 2 && strings.HasPrefix(f[0], "HTTP/") && (f[1] == "200" || f[1] == "407")
	})
	if ok {
		out.Kind = "http"
		return out
	}
	// Socks4（CONNECT 到 0.0.0.0:1，代理会拒绝，但回包格式能认出来）
	ok, _ = probeConn(target, timeout, []byte{0x04, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0x00}, func(c net.Conn) bool {
		b := make([]byte, 8)
		n, _ := c.Read(b)
		return n >= 2 && b[0] == 0x00 && b[1] >= 0x5A && b[1] <= 0x5D
	})
	if ok {
		out.Kind = "socks4"
	}
	return out
}

func proxyProbeCmd(targets string, timeout time.Duration) {
	var list []string
	for _, t := range strings.Split(targets, ",") {
		if t = strings.TrimSpace(t); t != "" {
			list = append(list, t)
		}
	}
	// 各个目标同时探测（每个最多三轮握手，慢的目标不拖累别的）
	out := make([]ProxyProbe, len(list))
	var wg sync.WaitGroup
	for i, t := range list {
		if _, _, err := net.SplitHostPort(t); err != nil {
			out[i] = ProxyProbe{Target: t, Error: "格式不对"}
			continue
		}
		wg.Add(1)
		go func(i int, t string) { defer wg.Done(); out[i] = probeProxy(t, timeout) }(i, t)
	}
	wg.Wait()
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
