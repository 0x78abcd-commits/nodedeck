package main

import (
	"os"
	"path/filepath"
	"strings"
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
	cases := []struct {
		carrier, want string
		hops          []Hop
	}{
		{"CT", "CN2 GIA", mk("10.0.0.1", "59.43.180.1", "59.43.1.2", "219.141.140.10")},
		{"CT", "CN2 GIA", mk("10.0.0.1", "59.43.180.1", "59.43.1.2", "202.97.1.9")}, // 最后一跳落到 163 不算 GT
		{"CT", "CN2 GT", mk("10.0.0.1", "202.97.50.1", "59.43.1.2", "59.43.3.3")},
		{"CT", "CN2 混合", mk("10.0.0.1", "59.43.1.2", "202.97.1.1", "202.97.1.2")},
		{"CT", "电信 163", mk("10.0.0.1", "202.97.12.1", "202.97.1.2")},
		{"CU", "联通 4837", mk("10.0.0.1", "219.158.3.1", "219.158.3.9")},
		{"CU", "联通 9929", mk("10.0.0.1", "218.105.2.1")},
		{"CU", "联通 9929 混合", mk("10.0.0.1", "219.158.3.1", "218.105.2.1")},
		{"CU", "联通 CUG（10099）", mk("10.0.0.1", "43.252.86.1", "219.158.3.1")},
		{"CM", "移动 CMIN2", mk("10.0.0.1", "223.119.8.1", "221.183.1.1")},
		{"CM", "移动 CMI", mk("10.0.0.1", "223.120.2.1", "221.183.1.1")},
		{"CM", "移动 CMNET", mk("10.0.0.1", "221.183.1.1")},
		{"CT", "未识别", mk("10.0.0.1", "*")},
		{"", "CN2 GIA", mk("10.0.0.1", "59.43.180.1", "59.43.1.2")},
	}
	for _, c := range cases {
		if got, _ := classifyRoute(c.carrier, c.hops); got != c.want {
			t.Errorf("%v: want %s got %s", c.hops, c.want, got)
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

func TestSysctlConflicts(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sysctl.conf")
	orig := "# comment\nnet.ipv4.tcp_congestion_control=cubic\n net.core.rmem_max = 16777216\nnet/ipv4/tcp_rmem = 4096 87380 6291456\nvm.swappiness=10\n"
	os.WriteFile(p, []byte(orig), 0644)
	disableConflicts(p, map[string]string{"net.ipv4.tcp_congestion_control": "bbr", "net.core.rmem_max": "16777216", "net.ipv4.tcp_rmem": "4096 131072 33554432"})
	b, _ := os.ReadFile(p)
	got := string(b)
	if !strings.Contains(got, offMark+"net.ipv4.tcp_congestion_control=cubic") || !strings.Contains(got, offMark+"net/ipv4/tcp_rmem") {
		t.Fatalf("冲突行没注释掉:\n%s", got)
	}
	if strings.Contains(got, offMark+" net.core.rmem_max") || strings.Contains(got, offMark+"vm.swappiness") {
		t.Fatalf("不该动的行被注释了:\n%s", got)
	}
	enableConflicts(p)
	b, _ = os.ReadFile(p)
	if string(b) != orig {
		t.Fatalf("恢复后不一致:\n%q", string(b))
	}
}
