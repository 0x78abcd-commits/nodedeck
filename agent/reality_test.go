package main

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRewriteSubs(t *testing.T) {
	pk := "PUBKEY_A"
	links := "vless://u@1.1.1.1:443?security=reality&sni=www.microsoft.com&pbk=PUBKEY_A&sid=1#A\n" +
		"vless://u@2.2.2.2:443?security=reality&sni=www.microsoft.com&pbk=PUBKEY_B&sid=1#B"
	got, _ := base64.StdEncoding.DecodeString(rewriteV2ray(base64.StdEncoding.EncodeToString([]byte(links)), pk, "www.microsoft.com", "a.example.com"))
	ls := strings.Split(string(got), "\n")
	if !strings.Contains(ls[0], "sni=a.example.com") || !strings.Contains(ls[1], "sni=www.microsoft.com") {
		t.Fatalf("v2ray rewrite wrong: %s", got)
	}
	clash := "proxies:\n  - {name: A, servername: www.microsoft.com, reality-opts: {public-key: PUBKEY_A}}\n  - {name: B, servername: www.microsoft.com, reality-opts: {public-key: PUBKEY_B}}"
	c := rewriteLines(clash, pk, "www.microsoft.com", "a.example.com")
	if !strings.Contains(strings.Split(c, "\n")[1], "a.example.com") || strings.Contains(strings.Split(c, "\n")[2], "a.example.com") {
		t.Fatalf("clash rewrite wrong: %s", c)
	}
	sb := `{"outbounds":[{"tag":"A","tls":{"server_name":"www.microsoft.com","reality":{"public_key":"PUBKEY_A"}}},{"tag":"B","tls":{"server_name":"www.microsoft.com","reality":{"public_key":"PUBKEY_B"}}}]}`
	o := rewriteSingbox(sb, pk, "a.example.com")
	if strings.Count(o, "a.example.com") != 1 {
		t.Fatalf("singbox rewrite wrong: %s", o)
	}
}

func TestBanList(t *testing.T) {
	b := &banList{fails: map[string][]time.Time{}, until: map[string]time.Time{}}
	for i := 0; i < 9; i++ {
		b.fail("1.2.3.4")
	}
	if b.banned("1.2.3.4") {
		t.Fatal("banned too early")
	}
	b.fail("1.2.3.4")
	if !b.banned("1.2.3.4") || b.banned("5.6.7.8") {
		t.Fatal("ban not applied correctly")
	}
}

func TestClientIPCloudflare(t *testing.T) {
	r, _ := http.NewRequest("GET", "/sub/x", nil)
	r.RemoteAddr = "162.158.1.2:443"
	r.Header.Set("CF-Connecting-IP", "1.2.3.4")
	if clientIP(r) != "1.2.3.4" {
		t.Fatal("should trust CF header from Cloudflare IP")
	}
	r.RemoteAddr = "8.8.8.8:443"
	if clientIP(r) != "8.8.8.8" {
		t.Fatal("must not trust CF header from non-Cloudflare IP")
	}
}
