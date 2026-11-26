package main

import (
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func freeTCP(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestForwardTCPUDP(t *testing.T) {
	// TCP 回显目标
	echo, _ := net.Listen("tcp", "127.0.0.1:0")
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	// UDP 回显目标
	uecho, _ := net.ListenPacket("udp", echo.Addr().String())
	defer uecho.Close()
	go func() {
		b := make([]byte, 2048)
		for {
			n, from, err := uecho.ReadFrom(b)
			if err != nil {
				return
			}
			uecho.WriteTo(b[:n], from)
		}
	}()
	dead := "127.0.0.1:" + itoa(freeTCP(t)) // 第一个目标不通，应该自动换到第二个
	port := freeTCP(t)
	m := newFwdManager(filepath.Join(t.TempDir(), "f.json"))
	m.apply([]FwdRule{{ID: "r1", Listen: port, Targets: []string{dead, echo.Addr().String()}}})
	time.Sleep(300 * time.Millisecond)

	c, err := net.Dial("tcp", "127.0.0.1:"+itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte("hello nodedeck")
	c.Write(msg)
	got := make([]byte, len(msg))
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, got); err != nil || string(got) != string(msg) {
		t.Fatalf("tcp echo: %q %v", got, err)
	}
	c.Close()

	u, _ := net.Dial("udp", "127.0.0.1:"+itoa(port))
	u.Write([]byte("ping"))
	u.SetReadDeadline(time.Now().Add(3 * time.Second))
	b := make([]byte, 16)
	n, err := u.Read(b)
	if err != nil || string(b[:n]) != "ping" {
		t.Fatalf("udp echo: %q %v", b[:n], err)
	}
	time.Sleep(200 * time.Millisecond)
	st := m.status()["r1"]
	if st.Up < int64(len(msg)+4) || st.Down < int64(len(msg)+4) || st.Total < 2 {
		t.Fatalf("stats: %+v", st)
	}
	m.rules["r1"].probe()
	st = m.status()["r1"]
	if st.Targets[0].OK || !st.Targets[1].OK {
		t.Fatalf("probe: %+v", st.Targets)
	}
	// 只允许别的 IP：本机连进来会被直接断开
	m.apply([]FwdRule{{ID: "r1", Listen: port, Targets: []string{echo.Addr().String()}, Allow: []string{"10.0.0.0/8"}}})
	time.Sleep(300 * time.Millisecond)
	c2, err := net.Dial("tcp", "127.0.0.1:"+itoa(port))
	if err == nil {
		c2.Write(msg)
		c2.SetReadDeadline(time.Now().Add(time.Second))
		if n, _ := c2.Read(got); n > 0 {
			t.Fatal("allowlist not enforced")
		}
		c2.Close()
	}
	// 流量在规则变更后保留
	if s := m.status()["r1"]; s.Up < int64(len(msg)) {
		t.Fatalf("traffic lost after change: %+v", s)
	}
	m.apply(nil)
}
