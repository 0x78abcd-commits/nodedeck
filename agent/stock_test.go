package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCheckStockRules(t *testing.T) {
	var inStock atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cf" {
			w.WriteHeader(403)
			w.Write([]byte(`<title>Just a moment...</title><div id="cf-chl-widget"></div>`))
			return
		}
		btn := `<span class="label">Out of <b>Stock</b></span>`
		if inStock.Load() {
			btn = `<a class="btn">Order Now</a>`
		}
		w.Write([]byte(`<html><head><title>VPS 套餐 A</title><script>var x="Out of Stock";</script></head><body><h1>套餐 A</h1>` + btn + `</body></html>`))
	}))
	defer srv.Close()
	gone := StockWatch{URL: srv.URL, Mode: "gone", Text: "out of stock"}
	appear := StockWatch{URL: srv.URL, Mode: "appear", Text: "Order Now"}
	re := StockWatch{URL: srv.URL, Mode: "regex", Text: `(?i)order\s+now`}
	r := checkStock(gone)
	if !r.OK || r.InStock || r.Title != "VPS 套餐 A" || !strings.Contains(r.Snippet, "Out of Stock") {
		t.Fatalf("缺货时 gone 规则判断错了：%+v", r)
	}
	if r := checkStock(appear); !r.OK || r.InStock {
		t.Fatalf("缺货时 appear 规则判断错了：%+v", r)
	}
	inStock.Store(true)
	// script 里还留着 "Out of Stock"，但页面上看不到了：gone 规则应判为有货
	if r := checkStock(gone); !r.OK || !r.InStock {
		t.Fatalf("有货时 gone 规则判断错了（脚本里的文字不该算）：%+v", r)
	}
	if r := checkStock(appear); !r.OK || !r.InStock {
		t.Fatalf("有货时 appear 规则判断错了：%+v", r)
	}
	if r := checkStock(re); !r.OK || !r.InStock {
		t.Fatalf("有货时 regex 规则判断错了：%+v", r)
	}
	if r := checkStock(StockWatch{URL: srv.URL + "/cf", Mode: "gone", Text: "x"}); r.OK || !strings.Contains(r.Error, "Cloudflare") {
		t.Fatalf("Cloudflare 拦截应报错且不改状态：%+v", r)
	}
}

func TestStockNotifyOnChange(t *testing.T) {
	var inStock atomic.Bool
	shop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if inStock.Load() {
			w.Write([]byte(`<a>Order Now</a>`))
		} else {
			w.Write([]byte(`<span>Sold out</span>`))
		}
	}))
	defer shop.Close()
	var msgs []string
	tg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		msgs = append(msgs, r.Form.Get("text"))
		w.Write([]byte(`{"ok":true}`))
	}))
	defer tg.Close()
	a := &Agent{cfg: Config{DataDir: t.TempDir(), Telegram: TelegramConfig{BotToken: "x", ChatID: "1", APIBase: tg.URL}}}
	w := StockWatch{ID: "w1", Name: "套餐 A", URL: shop.URL, Mode: "gone", Text: "sold out", Enabled: true}
	a.cfg.Stock = &StockCfg{Watches: []StockWatch{w}}
	a.loadStock()
	a.stockOnce(w) // 缺货：首次不通知
	if len(msgs) != 0 {
		t.Fatalf("首次缺货不该通知：%v", msgs)
	}
	inStock.Store(true)
	a.stockOnce(w)
	a.stockOnce(w) // 状态没变，不重复通知
	inStock.Store(false)
	a.stockOnce(w)
	if len(msgs) != 2 || !strings.Contains(msgs[0], "补货了") || !strings.Contains(msgs[1], "又没货了") {
		t.Fatalf("通知不对：%v", msgs)
	}
	// 重启后沿用状态，不重复发
	a.loadStock()
	a.stockOnce(w)
	if len(msgs) != 2 {
		t.Fatalf("重启后不该重复通知：%v", msgs)
	}
	st := a.stockStatus()["w1"]
	if st == nil || st.InStock == nil || *st.InStock {
		t.Fatalf("状态不对：%+v", st)
	}
}
