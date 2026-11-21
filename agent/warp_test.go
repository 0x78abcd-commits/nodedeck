package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWarpRegister(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var req map[string]any
		json.Unmarshal(b, &req)
		gotKey, _ = req["key"].(string)
		if r.Header.Get("CF-Client-Version") == "" {
			w.WriteHeader(400)
			return
		}
		io.WriteString(w, `{"id":"abc","token":"tok","config":{"client_id":"AQID","peers":[{"public_key":"bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=","endpoint":{"v4":"162.159.192.7:0","v6":"[2606:4700:d0::a29f:c001]:0","host":"engage.cloudflareclient.com:2408"}}],"interface":{"addresses":{"v4":"172.16.0.2","v6":"2606:4700:110:8a36::1"}}}}`)
	}))
	defer srv.Close()
	acc, err := warpRegister(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(gotKey) != 44 {
		t.Errorf("公钥长度不对: %q", gotKey)
	}
	if acc.Reserved[0] != 1 || acc.Reserved[1] != 2 || acc.Reserved[2] != 3 {
		t.Errorf("reserved 解析错误: %v", acc.Reserved)
	}
	if acc.EndpointHost != "162.159.192.7" || acc.EndpointPort != 2408 || acc.Address4 != "172.16.0.2" || len(acc.PrivateKey) != 44 {
		t.Errorf("账号字段不对: %+v", acc)
	}
}

func TestSplitRule(t *testing.T) {
	got := splitRule(`PREROUTING -p udp -m udp --dport 20000:30000 -m comment --comment "nodedeck-hop" -j REDIRECT --to-ports 443`)
	if len(got) != 15 || got[10] != "nodedeck-hop" {
		t.Errorf("%q", got)
	}
}
