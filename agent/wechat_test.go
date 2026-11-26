package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestServerChanURL(t *testing.T) {
	if u := serverChanURL("SCT123abc", ""); u != "https://sctapi.ftqq.com/SCT123abc.send" {
		t.Fatal(u)
	}
	if u := serverChanURL("sctp4567tAbCd", ""); u != "https://4567.push.ft07.com/send/sctp4567tAbCd.send" {
		t.Fatal(u)
	}
}

func TestNotifyTitle(t *testing.T) {
	if s := notifyTitle("【东京】⛔ 用户「a」已到期\n详情"); s != "【东京】⛔ 用户「a」已到期" {
		t.Fatal(s)
	}
	long := strings.Repeat("字", 40)
	if r := []rune(notifyTitle(long)); len(r) != 33 {
		t.Fatal(len(r))
	}
}

func TestSendAllChannels(t *testing.T) {
	var mu sync.Mutex
	got := map[string]string{}
	sc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		mu.Lock()
		got["sc"] = r.URL.Path + "|" + r.Form.Get("title") + "|" + r.Form.Get("desp")
		mu.Unlock()
		io.WriteString(w, `{"code":0,"message":"","data":{}}`)
	}))
	defer sc.Close()
	pp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]string
		json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		got["pp"] = b["token"] + "|" + b["title"] + "|" + b["content"]
		mu.Unlock()
		io.WriteString(w, `{"code":200,"msg":"请求成功","data":"x"}`)
	}))
	defer pp.Close()
	a := &Agent{cfg: Config{Wechat: WechatConfig{ServerChan: "SCTk", PushPlus: "ppk", ServerChanAPI: sc.URL, PushPlusAPI: pp.URL}}}
	if !a.notifyOn() || a.tgEnabled() {
		t.Fatal("渠道判断不对")
	}
	if err := a.sendAll("标题行\n第二行"); err != nil {
		t.Fatal(err)
	}
	if got["sc"] != "/SCTk.send|标题行|标题行\n\n第二行" {
		t.Fatalf("server酱: %q", got["sc"])
	}
	if got["pp"] != "ppk|标题行|标题行\n第二行" {
		t.Fatalf("pushplus: %q", got["pp"])
	}
}

func TestSendAllError(t *testing.T) {
	pp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"code":903,"msg":"无效的用户token"}`)
	}))
	defer pp.Close()
	a := &Agent{cfg: Config{Wechat: WechatConfig{PushPlus: "bad", PushPlusAPI: pp.URL}}}
	err := a.sendAll("x")
	if err == nil || !strings.Contains(err.Error(), "PushPlus") || !strings.Contains(err.Error(), "无效的用户token") {
		t.Fatal(err)
	}
	if (&Agent{}).sendAll("x") == nil {
		t.Fatal("没渠道应该报错")
	}
}
