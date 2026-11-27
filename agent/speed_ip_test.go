package main

import (
	"net"
	"testing"
)

func TestPublicIP(t *testing.T) {
	for ip, want := range map[string]bool{"8.8.8.8": true, "1.1.1.1": true, "127.0.0.1": false, "10.1.2.3": false, "169.254.169.254": false, "100.64.1.1": false, "0.1.2.3": false, "224.0.0.1": false, "::1": false, "fd00::1": false, "2606:4700::1111": true} {
		if got := publicIP(net.ParseIP(ip)); got != want {
			t.Errorf("%s: got %v want %v", ip, got, want)
		}
	}
}
