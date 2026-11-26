package main

// 补货提醒（内置轻量版）：定时打开商品页，按文字规则判断有货 / 缺货，状态变了就发通知（Telegram / 微信）。
//   - 规则：gone = 页面上「缺货文字」消失算有货（最常用，如 Out of Stock / 缺货）
//           appear = 页面上出现「有货文字」算有货（如 Order Now / 立即购买）
//           regex = 正则能匹配算有货
//   - 打不开、被 Cloudflare 拦、返回 4xx/5xx 时不改状态，只记错误（不会误报补货）
//   - 第一次检查如果就是有货，也发一条，让人知道监控生效了
//   - 只看页面源码，不跑 JavaScript；要看 JS 页面请用 changedetection.io（NodeDeck 也能一键装）
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

type StockWatch struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	Mode     string `json:"mode"` // gone / appear / regex
	Text     string `json:"text"`
	Interval int    `json:"interval"` // 秒，最少 30
	Enabled  bool   `json:"enabled"`
}

type StockCfg struct {
	Watches []StockWatch `json:"watches"`
}

type StockState struct {
	InStock    *bool  `json:"inStock"` // nil = 还没成功检查过
	LastCheck  int64  `json:"lastCheck"`
	LastOK     int64  `json:"lastOk"`
	LastChange int64  `json:"lastChange"`
	Error      string `json:"error,omitempty"`
	Sig        string `json:"sig"` // 规则变了就重新开始（不沿用旧状态）
}

type stockStore struct {
	mu sync.Mutex
	m  map[string]*StockState
}

type StockResult struct {
	OK      bool   `json:"ok"`
	InStock bool   `json:"inStock"`
	Status  int    `json:"status"`
	Title   string `json:"title"`
	Snippet string `json:"snippet"` // 命中的那段文字（前后一点上下文）
	Error   string `json:"error,omitempty"`
	Bytes   int    `json:"bytes"`
}

var (
	tagRe     = regexp.MustCompile(`(?s)<script.*?</script>|<style.*?</style>|<[^>]+>`)
	spaceRe   = regexp.MustCompile(`\s+`)
	titleRe   = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	stockHTTP = &http.Client{Timeout: 25 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("跳转次数太多")
		}
		return nil
	}}
)

func watchSig(w StockWatch) string {
	h := sha256.Sum256([]byte(w.URL + "\x00" + w.Mode + "\x00" + w.Text))
	return hex.EncodeToString(h[:8])
}

func pageText(body string) string {
	return strings.TrimSpace(spaceRe.ReplaceAllString(html.UnescapeString(tagRe.ReplaceAllString(body, " ")), " "))
}

func snippetAround(s string, i, n int) string {
	if i > len(s) {
		i = len(s)
	}
	r := []rune(s)
	// i 是字节位置，换成字符位置
	ri := len([]rune(s[:i]))
	a, b := ri-30, ri+n+30
	if a < 0 {
		a = 0
	}
	if b > len(r) {
		b = len(r)
	}
	return string(r[a:b])
}

// checkStock 打开一次页面并按规则判断
func checkStock(w StockWatch) StockResult {
	req, err := http.NewRequest("GET", w.URL, nil)
	if err != nil {
		return StockResult{Error: "链接不对：" + err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := stockHTTP.Do(req)
	if err != nil {
		return StockResult{Error: "打不开：" + shortErr(err)}
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 5<<20))
	body := string(b)
	r := StockResult{Status: resp.StatusCode, Bytes: len(b)}
	if m := titleRe.FindStringSubmatch(body); m != nil {
		r.Title = strings.TrimSpace(html.UnescapeString(spaceRe.ReplaceAllString(m[1], " ")))
	}
	if resp.StatusCode == 403 || resp.StatusCode == 503 || resp.StatusCode == 429 {
		if strings.Contains(body, "cf-chl") || strings.Contains(body, "challenge-platform") || strings.Contains(r.Title, "Just a moment") {
			r.Error = "被 Cloudflare 人机验证拦住了（这种页面请用 changedetection.io 带浏览器的模式）"
		} else {
			r.Error = fmt.Sprintf("网站返回 HTTP %d（可能拦了机房 IP 或访问太频繁）", resp.StatusCode)
		}
		return r
	}
	if resp.StatusCode >= 400 {
		r.Error = fmt.Sprintf("网站返回 HTTP %d", resp.StatusCode)
		return r
	}
	text := pageText(body)
	r.OK = true
	switch w.Mode {
	case "regex":
		re, err := regexp.Compile(w.Text)
		if err != nil {
			r.OK, r.Error = false, "正则写得不对："+err.Error()
			return r
		}
		if loc := re.FindStringIndex(text); loc != nil {
			r.InStock, r.Snippet = true, snippetAround(text, loc[0], loc[1]-loc[0])
		} else if loc := re.FindStringIndex(body); loc != nil {
			r.InStock, r.Snippet = true, snippetAround(body, loc[0], loc[1]-loc[0])
		}
	default:
		needle := strings.ToLower(strings.TrimSpace(w.Text))
		if needle == "" {
			r.OK, r.Error = false, "没填要找的文字"
			return r
		}
		// 只看页面上能看到的文字（去掉标签、脚本、样式）：脚本里常有藏着的「缺货」模板字符串，按源码找会一直误判缺货
		found := false
		if i := strings.Index(strings.ToLower(text), needle); i >= 0 {
			found, r.Snippet = true, snippetAround(text, i, len([]rune(needle)))
		}
		if w.Mode == "appear" {
			r.InStock = found
		} else {
			r.InStock = !found
		}
	}
	return r
}

func (a *Agent) stockPath() string { return a.path("stock.json") }

func (a *Agent) loadStock() {
	a.stock = &stockStore{m: map[string]*StockState{}}
	if b, err := os.ReadFile(a.stockPath()); err == nil {
		_ = json.Unmarshal(b, &a.stock.m)
	}
}

func (a *Agent) saveStock() {
	a.stock.mu.Lock()
	b, _ := json.MarshalIndent(a.stock.m, "", "  ")
	a.stock.mu.Unlock()
	_ = writeFileAtomic(a.stockPath(), b, 0600)
}

func (a *Agent) stockLoop() {
	if a.cfg.Stock == nil || len(a.cfg.Stock.Watches) == 0 {
		return
	}
	a.loadStock()
	for _, w := range a.cfg.Stock.Watches {
		if !w.Enabled || w.URL == "" {
			continue
		}
		go a.stockWatchLoop(w)
	}
}

func (a *Agent) stockWatchLoop(w StockWatch) {
	iv := time.Duration(w.Interval) * time.Second
	if iv < 30*time.Second {
		iv = 30 * time.Second
	}
	// 错开启动时间，多个监控不同时打
	time.Sleep(time.Duration(rand.Int63n(int64(10 * time.Second))))
	for {
		a.stockOnce(w)
		// 每次加一点随机抖动，看起来不像机器定时刷
		time.Sleep(iv + time.Duration(rand.Int63n(int64(iv/5)+1)))
	}
}

func (a *Agent) stockOnce(w StockWatch) {
	r := checkStock(w)
	now := time.Now().Unix()
	sig := watchSig(w)
	a.stock.mu.Lock()
	st := a.stock.m[w.ID]
	if st == nil || st.Sig != sig {
		st = &StockState{Sig: sig}
		a.stock.m[w.ID] = st
	}
	st.LastCheck = now
	var msg string
	if r.OK {
		st.Error, st.LastOK = "", now
		prev := st.InStock
		in := r.InStock
		st.InStock = &in
		if prev == nil {
			st.LastChange = now
			if in {
				msg = fmt.Sprintf("🟢 %s 现在有货（开始监控）\n%s", w.Name, w.URL)
			}
		} else if *prev != in {
			st.LastChange = now
			if in {
				msg = fmt.Sprintf("🟢 %s 补货了！\n%s", w.Name, w.URL)
			} else {
				msg = fmt.Sprintf("⚪ %s 又没货了", w.Name)
			}
		}
	} else {
		st.Error = r.Error
	}
	a.stock.mu.Unlock()
	a.saveStock()
	if msg != "" {
		log.Printf("补货提醒：%s", strings.SplitN(msg, "\n", 2)[0])
		if a.notifyOn() {
			if err := a.sendAll("【补货提醒】" + msg); err != nil {
				log.Printf("发送补货提醒失败: %v", err)
			}
		}
	}
}

// stockStatus 给桌面端看
func (a *Agent) stockStatus() map[string]*StockState {
	if a.stock == nil {
		return nil
	}
	a.stock.mu.Lock()
	defer a.stock.mu.Unlock()
	out := map[string]*StockState{}
	for _, w := range a.cfg.Stock.Watches {
		if st := a.stock.m[w.ID]; st != nil && st.Sig == watchSig(w) {
			cp := *st
			out[w.ID] = &cp
		}
	}
	return out
}
