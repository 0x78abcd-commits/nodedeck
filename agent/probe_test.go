package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbeAuth(t *testing.T) {
	a := &Agent{cfg: Config{Probe: &ProbeCfg{Key: "k123", Host: &ProbeHost{Token: "tok", Title: "T", Peers: []ProbePeer{{ID: "a", Name: "A", Self: true}}}}}, metrics: &Metrics{}, disabled: map[string]string{}}
	a.hub = &probeHub{peers: map[string]*peerState{}}
	rec := httptest.NewRecorder()
	a.handleProbeData(rec, httptest.NewRequest("GET", "/probe/data", nil))
	if rec.Code != 404 {
		t.Fatalf("没带密钥应 404，得到 %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/probe/data?range=now", nil)
	req.Header.Set("Authorization", "Bearer k123")
	a.handleProbeData(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"live"`) {
		t.Fatalf("带密钥应返回数据：%d %s", rec.Code, rec.Body.String())
	}
	for path, want := range map[string]int{"/p/wrong/": 404, "/p/tok/": 200, "/p/tok/api/servers": 200, "/p/tok/api/nope": 404, "/p/tokx/": 404} {
		rec = httptest.NewRecorder()
		a.handleProbePage(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("%s: 得到 %d，应为 %d", path, rec.Code, want)
		}
	}
	rec = httptest.NewRecorder()
	a.handleProbePage(rec, httptest.NewRequest("GET", "/p/tok/api/servers", nil))
	if strings.Contains(rec.Body.String(), "addr") || strings.Contains(rec.Body.String(), "k123") {
		t.Fatalf("网页接口不能带地址或密钥：%s", rec.Body.String())
	}
}
