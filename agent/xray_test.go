package main

import (
	"os"
	"strings"
	"testing"
)

func TestFilterXray(t *testing.T) {
	full := []byte(`{"inbounds":[{"tag":"a","settings":{"clients":[{"id":"1","email":"owner"},{"id":"2","email":"bob"}],"decryption":"none"}},{"tag":"b","settings":{"clients":[{"id":"2","email":"bob"}]}}],"outbounds":[{"protocol":"socks"}]}`)
	out, err := filterXray(full, map[string]string{"bob": "quota"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if !strings.Contains(s, `"owner"`) || strings.Contains(s, `"bob"`) {
		t.Fatalf("过滤结果不对: %s", s)
	}
}

func TestXrayDigestCerts(t *testing.T) {
	d := t.TempDir()
	cf := d + "/c.pem"
	os.WriteFile(cf, []byte("A"), 0600)
	cfg := []byte(`{"inbounds":[{"streamSettings":{"tlsSettings":{"certificates":[{"certificateFile":"` + cf + `","keyFile":"` + cf + `"}]}}}]}`)
	s1, ok := xrayDigest(cfg)
	if !ok {
		t.Fatal("证书存在却报不存在")
	}
	os.WriteFile(cf, []byte("B"), 0600)
	if s2, _ := xrayDigest(cfg); s2 == s1 {
		t.Fatal("证书变了摘要没变")
	}
	os.Remove(cf)
	if _, ok := xrayDigest(cfg); ok {
		t.Fatal("证书不存在应报 false")
	}
}

// XRAY_API=127.0.0.1:18093 go test -run TestXrayStatsLive：对着真 Xray 读一次统计
func TestXrayStatsLive(t *testing.T) {
	addr := os.Getenv("XRAY_API")
	if addr == "" {
		t.Skip("没设 XRAY_API")
	}
	m, err := queryStatsAt(addr, xrayStatsPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%v", m)
	if len(m) == 0 {
		t.Fatal("没有统计")
	}
}

func TestClashFor(t *testing.T) {
	s := Sub{Clash: "full", ClashLegacy: "legacy"}
	for ua, want := range map[string]string{
		"mihomo/1.19.10":                  "legacy",
		"mihomo/v1.19.22":                 "full",
		"clash.meta/v1.18.0":              "legacy",
		"clash-verge/v2.4.2":              "full",
		"ClashMetaForAndroid/2.11.5.Meta": "full",
		"ClashforWindows/0.20.39":         "legacy",
		"FlClash/v0.8.80 clash-verge":     "full",
		"":                                "full",
	} {
		if got := clashFor(s, ua); got != want {
			t.Errorf("%q: got %s want %s", ua, got, want)
		}
	}
}

func TestSwitchXrayReality(t *testing.T) {
	in := []byte(`{"inbounds":[{"tag":"xhttp-reality-in","streamSettings":{"security":"reality","realitySettings":{"target":"old.com:443","serverNames":["old.com"],"privateKey":"k"}}},{"tag":"xhttp-tls-in","streamSettings":{"security":"tls"}}]}`)
	out, ok := switchXrayReality(in, "new.com")
	if !ok || !strings.Contains(string(out), `"new.com:443"`) || strings.Contains(string(out), "old.com") || !strings.Contains(string(out), `"privateKey": "k"`) {
		t.Fatalf("换目标结果不对: %s", out)
	}
	if _, ok := switchXrayReality([]byte(`{"inbounds":[{"streamSettings":{"security":"tls"}}]}`), "x.com"); ok {
		t.Fatal("没有 Reality 入站应返回 false")
	}
}
