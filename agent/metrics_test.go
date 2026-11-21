package main

import (
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCollect(t *testing.T) {
	a := &Agent{cfg: Config{Timezone: "Asia/Shanghai"}, metrics: &Metrics{}}
	a.collect(false)
	time.Sleep(1100 * time.Millisecond)
	a.collect(false)
	r := a.metricsFor("1h")
	if r.Now == nil || r.Now.Mem <= 0 || r.Now.Mem > 100 || r.Now.CPU < 0 || r.Now.CPU > 100 {
		t.Fatalf("采样不对: %+v", r.Now)
	}
	if r.DiskTotal == 0 || r.Cores == 0 || r.Month.Month == "" {
		t.Errorf("磁盘/核心数/月份: %+v", r)
	}
	// 小时聚合
	avg := avgSamples([]Sample{{CPU: 10, Lat: map[string]float64{"电信": 100}}, {CPU: 30, Lat: map[string]float64{"电信": -1}}}, 1)
	if avg.CPU != 20 || avg.Lat["电信"] != 100 {
		t.Errorf("平均值不对: %+v", avg)
	}
}

func TestPingParse(t *testing.T) {
	for _, s := range []string{"rtt min/avg/max/mdev = 1.234/5.678/9.0/0.1 ms", "round-trip min/avg/max = 1.2/5.678/9.0 ms"} {
		m := pingAvg.FindStringSubmatch(s)
		if m == nil || m[1] != "5.678" {
			t.Errorf("%s → %v", s, m)
		}
	}
}

func TestTLSProbe(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "https://")
	st, ms, err := tlsProbe(addr, "example.com", 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if st.NegotiatedProtocol != "h2" || ms < 0 {
		t.Errorf("协商结果: %s", st.NegotiatedProtocol)
	}
	if d := pickDomain(&x509.Certificate{DNSNames: []string{"*.a.com", "1.2.3.4", "www.b.com"}}); d != "www.b.com" {
		t.Errorf("pickDomain: %s", d)
	}
}
