package main

// Reality 目标扫描：在 VPS 所在的 /24 网段里找支持 TLS 1.3 + HTTP/2 + X25519、证书有效的网站，
// 再用域名本身复测，按握手延迟排序（离 VPS 越近越适合当 Reality 目标）
import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type ScanHit struct {
	Domain   string `json:"domain"`
	IP       string `json:"ip"`
	Ms       int64  `json:"ms"`
	Issuer   string `json:"issuer"`
	NotAfter string `json:"notAfter"`
}

func tlsProbe(addr, sni string, timeout time.Duration) (*tls.ConnectionState, int64, error) {
	d := &net.Dialer{Timeout: timeout}
	cfg := &tls.Config{
		ServerName:         sni,
		InsecureSkipVerify: true, // 先拿证书，稍后单独校验
		NextProtos:         []string{"h2", "http/1.1"},
		MinVersion:         tls.VersionTLS13,
		CurvePreferences:   []tls.CurveID{tls.X25519},
	}
	t0 := time.Now()
	c, err := tls.DialWithDialer(d, "tcp", addr, cfg)
	if err != nil {
		return nil, 0, err
	}
	defer c.Close()
	st := c.ConnectionState()
	return &st, time.Since(t0).Milliseconds(), nil
}

func pickDomain(cert *x509.Certificate) string {
	for _, d := range cert.DNSNames {
		if !strings.Contains(d, "*") && net.ParseIP(d) == nil && strings.Contains(d, ".") {
			return d
		}
	}
	return ""
}

func scanReality(selfIP string, timeout time.Duration, workers int) ([]ScanHit, error) {
	ip := net.ParseIP(selfIP).To4()
	if ip == nil {
		return nil, fmt.Errorf("需要 VPS 的 IPv4 地址")
	}
	type cand struct{ ip, domain string }
	var mu sync.Mutex
	var cands []cand
	jobs := make(chan string)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for target := range jobs {
				st, _, err := tlsProbe(net.JoinHostPort(target, "443"), "", timeout)
				if err != nil || st.NegotiatedProtocol != "h2" || len(st.PeerCertificates) == 0 {
					continue
				}
				if d := pickDomain(st.PeerCertificates[0]); d != "" {
					mu.Lock()
					cands = append(cands, cand{target, d})
					mu.Unlock()
				}
			}
		}()
	}
	for i := 1; i < 255; i++ {
		t := net.IPv4(ip[0], ip[1], ip[2], byte(i)).String()
		if t != selfIP {
			jobs <- t
		}
	}
	close(jobs)
	wg.Wait()

	// 用域名本身复测：Reality 是按域名去连目标的
	seen := map[string]bool{}
	var hits []ScanHit
	var hmu sync.Mutex
	var wg2 sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, c := range cands {
		if seen[c.domain] {
			continue
		}
		seen[c.domain] = true
		wg2.Add(1)
		sem <- struct{}{}
		go func(c cand) {
			defer wg2.Done()
			defer func() { <-sem }()
			st, ms, err := tlsProbe(net.JoinHostPort(c.domain, "443"), c.domain, timeout*2)
			if err != nil || st.NegotiatedProtocol != "h2" || len(st.PeerCertificates) == 0 {
				return
			}
			leaf := st.PeerCertificates[0]
			inter := x509.NewCertPool()
			for _, ic := range st.PeerCertificates[1:] {
				inter.AddCert(ic)
			}
			if _, err := leaf.Verify(x509.VerifyOptions{DNSName: c.domain, Intermediates: inter}); err != nil {
				return // 证书无效（自签、过期、域名不符）不适合
			}
			hmu.Lock()
			hits = append(hits, ScanHit{Domain: c.domain, IP: c.ip, Ms: ms, Issuer: leaf.Issuer.CommonName, NotAfter: leaf.NotAfter.Format("2006-01-02")})
			hmu.Unlock()
		}(c)
	}
	wg2.Wait()
	sort.Slice(hits, func(i, j int) bool { return hits[i].Ms < hits[j].Ms })
	if len(hits) > 30 {
		hits = hits[:30]
	}
	return hits, nil
}

func scanRealityCmd(selfIP string, timeout time.Duration) {
	hits, err := scanReality(selfIP, timeout, 48)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if hits == nil {
		hits = []ScanHit{}
	}
	b, _ := json.Marshal(hits)
	os.Stdout.Write(b)
	fmt.Println()
}
