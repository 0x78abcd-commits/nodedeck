package main

import (
	"os"
	"testing"
	"time"
)

func TestClassifyRoute(t *testing.T) {
	mk := func(ips ...string) []Hop {
		var h []Hop
		for i, ip := range ips {
			h = append(h, Hop{TTL: i + 1, IP: ip})
		}
		return h
	}
	cases := map[string][]Hop{
		"CN2 GIA":        mk("10.0.0.1", "59.43.180.1", "59.43.1.2", "219.141.140.10"),
		"CN2 GT":         mk("10.0.0.1", "202.97.50.1", "59.43.1.2"),
		"电信 163":         mk("10.0.0.1", "202.97.12.1", "202.97.1.2"),
		"联通 4837":        mk("10.0.0.1", "219.158.3.1"),
		"联通 9929":        mk("10.0.0.1", "218.105.2.1"),
		"移动 CMI / CMIN2": mk("10.0.0.1", "223.120.2.1", "221.183.1.1"),
		"移动 CMNET":       mk("10.0.0.1", "221.183.1.1"),
		"未识别":            mk("10.0.0.1", "*"),
	}
	for want, hops := range cases {
		if got, _ := classifyRoute(hops); got != want {
			t.Errorf("want %s got %s", want, got)
		}
	}
}

func TestICMPLocal(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("需要 root")
	}
	r := icmpPing("127.0.0.1", 5, 50*time.Millisecond, time.Second)
	if r.Error != "" || r.Recv != 5 || r.Loss != 0 {
		t.Fatalf("ping 127.0.0.1: %+v", r)
	}
	tr := traceICMP("127.0.0.1", 5)
	if !tr.Reached || len(tr.Hops) != 1 {
		t.Fatalf("trace 127.0.0.1: %+v", tr)
	}
	if m, err := pathMTU("127.0.0.1"); err != nil || m < 1400 {
		t.Fatalf("mtu: %d %v", m, err)
	}
}

func TestRecommendSmallBox(t *testing.T) {
	ni := NetInfo{BBRSupport: true, MemMB: 985, Sysctl: map[string]string{
		"net.ipv4.tcp_congestion_control": "cubic", "net.core.default_qdisc": "fq_codel",
		"net.ipv4.tcp_rmem": "4096 131072 6291456", "net.ipv4.tcp_wmem": "4096 16384 4194304",
		"net.core.rmem_max": "212992", "net.core.wmem_max": "212992", "net.ipv4.tcp_mtu_probing": "0", "net.ipv4.tcp_window_scaling": "1"}}
	items := recommend(ni)
	got := map[string]string{}
	for _, it := range items {
		if it.Apply {
			got[it.Key] = it.Want
		}
	}
	if got["net.ipv4.tcp_congestion_control"] != "bbr" || got["net.core.default_qdisc"] != "fq" || got["net.ipv4.tcp_rmem"] != "4096 131072 16777216" || got["net.core.rmem_max"] != "16777216" || got["net.ipv4.tcp_mtu_probing"] != "1" {
		t.Fatalf("unexpected: %v", got)
	}
	ni.BBRSupport = false
	for _, it := range recommend(ni) {
		if it.Key == "net.ipv4.tcp_congestion_control" {
			t.Fatal("no bbr support should not recommend bbr")
		}
	}
}
