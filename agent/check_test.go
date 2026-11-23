package main

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func itemOK(r TargetResult, name string) bool {
	for _, c := range r.Checks {
		if c.Name == name {
			return c.OK
		}
	}
	return false
}

// 用本地 TLS 服务器检查各项判定：只支持 TLS 1.2、不支持 X25519、自签证书
func TestCheckTargetItems(t *testing.T) {
	mk := func(cfg *tls.Config) string {
		s := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		s.EnableHTTP2 = true
		s.TLS = cfg
		s.StartTLS()
		t.Cleanup(s.Close)
		return s.Listener.Addr().String()
	}
	check := func(addr string) TargetResult {
		host, port, _ := net.SplitHostPort(addr)
		// checkTarget 固定连 443，这里直接复用内部逻辑：临时替换地址
		old := targetPort
		targetPort = port
		defer func() { targetPort = old }()
		return checkTarget(host, 3*time.Second)
	}
	r := check(mk(&tls.Config{MaxVersion: tls.VersionTLS12}))
	if itemOK(r, "TLS 1.3") || itemOK(r, "X25519") || r.OK {
		t.Fatalf("TLS 1.2 server should fail TLS 1.3 and X25519: %+v", r)
	}
	r = check(mk(&tls.Config{MinVersion: tls.VersionTLS13, CurvePreferences: []tls.CurveID{tls.CurveP256}}))
	if !itemOK(r, "TLS 1.3") || itemOK(r, "X25519") {
		t.Fatalf("P-256 only server should pass TLS 1.3 but fail X25519: %+v", r)
	}
	if !itemOK(r, "HTTP/2") {
		t.Fatalf("h2 should pass: %+v", r)
	}
	if itemOK(r, "证书有效") {
		t.Fatalf("self-signed cert must fail: %+v", r)
	}
	r = check(mk(&tls.Config{}))
	if !itemOK(r, "TLS 1.3") || !itemOK(r, "X25519") || itemOK(r, "证书有效") || r.OK {
		t.Fatalf("default server: TLS1.3+X25519 ok, cert bad: %+v", r)
	}
}
