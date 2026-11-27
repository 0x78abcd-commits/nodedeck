package main

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 起一个只会按 handler 回话的 TCP 服务
func fakeServer(t *testing.T, h func(c net.Conn)) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); h(c) }()
		}
	}()
	return ln.Addr().String()
}

func TestProbeProxy(t *testing.T) {
	to := 2 * time.Second
	socks5 := fakeServer(t, func(c net.Conn) {
		b := make([]byte, 4)
		c.Read(b)
		if b[0] == 5 {
			c.Write([]byte{5, 2})
		}
	})
	httpProxy := fakeServer(t, func(c net.Conn) {
		l, _ := bufio.NewReader(c).ReadString('\n')
		if strings.HasPrefix(l, "CONNECT") {
			c.Write([]byte("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"))
		}
	})
	socks4 := fakeServer(t, func(c net.Conn) {
		b := make([]byte, 9)
		n, _ := c.Read(b)
		if n > 0 && b[0] == 4 {
			c.Write([]byte{0, 0x5B, 0, 0, 0, 0, 0, 0})
		}
	})
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(405) }))
	defer web.Close()
	silent := fakeServer(t, func(c net.Conn) { time.Sleep(3 * time.Second) })
	cases := map[string]string{socks5: "socks5", httpProxy: "http", socks4: "socks4", strings.TrimPrefix(web.URL, "http://"): "", silent: ""}
	for addr, want := range cases {
		if got := probeProxy(addr, to); got.Kind != want || got.Error != "" {
			t.Errorf("%s: got %+v want %q", addr, got, want)
		}
	}
	if r := probeProxy("127.0.0.1:1", to); r.Error == "" {
		t.Errorf("closed port should error: %+v", r)
	}
}
