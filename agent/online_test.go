package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const sbSample = `INFO sing-box started (0.01s)
INFO [1030349158 0ms] inbound/vless[vless-in]: inbound connection from 1.2.3.4:51512
INFO [1030349158 0ms] inbound/vless[vless-in]: [u_alice] inbound connection to 127.0.0.1:24200
INFO [1030349158 0ms] outbound/direct[direct]: outbound connection to 127.0.0.1:24200
INFO [3164239019 0ms] inbound/hysteria2[hy2-in]: inbound connection from [2001:db8::5]:48827
INFO [3164239019 0ms] inbound/hysteria2[hy2-in]: [u_bob] inbound packet connection to 8.8.8.8:53
INFO [55 1ms] inbound/shadowsocks[ss-in]: [u_carol] inbound packet connection from 5.6.7.8:6000
INFO [77 0ms] inbound/vless[vless-in]: inbound connection from 127.0.0.1:4000
INFO [77 0ms] inbound/vless[vless-in]: [u_alice] inbound connection to x.com:443
INFO [78 0ms] inbound/vless[vless-in]: inbound connection from 9.9.9.9:4000
WARN [99 2ms] inbound/vless[vless-in]: process connection from 9.9.9.9:4000: REALITY: processed invalid connection
INFO [1030349159 0ms] inbound/vless[vless-in]: inbound connection from 1.2.3.5:51513
INFO [1030349159 0ms] inbound/vless[vless-in]: [u_alice] inbound connection to 127.0.0.1:24200
`

func TestOnlineSingbox(t *testing.T) {
	o := newOnlineTracker()
	warn := o.feedSingbox([]byte(sbSample), 1000)
	if len(warn) != 1 {
		t.Fatalf("warn %v", warn)
	}
	got := o.snapshot(1000)
	want := map[string][]string{"u_alice": {"1.2.3.4", "1.2.3.5"}, "u_bob": {"2001:db8::5"}, "u_carol": {"5.6.7.8"}}
	for u, ips := range want {
		if len(got[u]) != len(ips) {
			t.Fatalf("%s: %v", u, got[u])
		}
	}
	// 9.9.9.9 没认证成功，不算；过期后清掉
	if _, ok := got["u_alice"]; !ok || len(got) != 3 {
		t.Fatal(got)
	}
	if s := o.snapshot(1000 + onlineWindow + 1); len(s) != 0 {
		t.Fatal(s)
	}
}

func TestOnlineXray(t *testing.T) {
	o := newOnlineTracker()
	o.feedXray([]byte("2026/11/26 14:00:00.123456 from 1.2.3.4:5678 accepted tcp:www.google.com:443 [xhttp-in >> sing-box] email: u_dan\n2026/11/26 14:00:01 from tcp:[2001:db8::9]:1234 accepted udp:1.1.1.1:53 [xhttp-in >> sing-box] email: u_dan\n"), 50)
	if got := o.snapshot(50)["u_dan"]; !reflect.DeepEqual(len(got), 2) {
		t.Fatal(got)
	}
}

func TestDrainFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.log")
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	f.WriteString("a\n")
	if string(drainFile(p)) != "a\n" {
		t.Fatal("first")
	}
	f.WriteString("b\n") // 写入方继续追加，从头开始
	if string(drainFile(p)) != "b\n" {
		t.Fatal("second")
	}
	f.Close()
}
