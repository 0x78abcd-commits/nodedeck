package main

import (
	"strings"
	"testing"
)

func TestAllowRules(t *testing.T) {
	rules := []PortAllow{{Port: 443, Net: "tcp", Allow: []string{"1.2.3.4", "10.0.0.0/8", "2001:db8::1", "bad"}}, {Port: 80, Net: "tcp"}}
	v4 := allowRules(rules, false)
	if len(v4) != 3 { // 1 DROP + 2 ACCEPT；没有名单的 80 不处理
		t.Fatalf("v4 %d: %v", len(v4), v4)
	}
	if !strings.Contains(strings.Join(v4[0], " "), "-j DROP") || !strings.Contains(strings.Join(v4[2], " "), "-s 10.0.0.0/8") {
		t.Fatalf("order %v", v4)
	}
	v6 := allowRules(rules, true)
	if len(v6) != 2 || !strings.Contains(strings.Join(v6[1], " "), "2001:db8::1") {
		t.Fatalf("v6 %v", v6)
	}
	both := allowRules([]PortAllow{{Port: 8443, Net: "both", Allow: []string{"1.1.1.1"}}}, false)
	if len(both) != 4 {
		t.Fatalf("both %v", both)
	}
}
