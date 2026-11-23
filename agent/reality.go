package main

// Reality 目标巡检：定期检查当前「偷」的网站还能不能用（TLS 1.3 + HTTP/2 + X25519 + 证书有效）。
// 连续失败 3 次（间隔 10 分钟）后：mode=auto 自动换一个新目标（先扫同网段邻居，再试备选大站），
// 同时改写本机订阅里这台服务器的节点并发 Telegram 通知；mode=notify 只通知；off 不检查。
import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

type RealityCfg struct {
	Mode       string   `json:"mode"` // auto / notify / off
	SNI        string   `json:"sni"`
	PublicKey  string   `json:"publicKey"`
	SelfIP     string   `json:"selfIp"`
	Candidates []string `json:"candidates"`
}

// 巡检状态，desktop 通过 stats 读取；Override 表示 agent 自己换过目标
type RealityState struct {
	Current   string `json:"current"`
	LastCheck int64  `json:"lastCheck"`
	LastOK    int64  `json:"lastOk"`
	Fails     int    `json:"fails"`
	LastErr   string `json:"lastErr,omitempty"`
	Override  string `json:"override,omitempty"`
	From      string `json:"from,omitempty"`
	ChangedAt int64  `json:"changedAt,omitempty"`
}

type TargetResult struct {
	Domain string `json:"domain"`
	OK     bool   `json:"ok"`
	Ms     int64  `json:"ms"`
	Error  string `json:"error,omitempty"`
}

// checkTarget 用域名本身握手，要求 TLS 1.3 + h2 + X25519 且证书有效
func checkTarget(domain string, timeout time.Duration) TargetResult {
	r := TargetResult{Domain: domain}
	st, ms, err := tlsProbe(net.JoinHostPort(domain, "443"), domain, timeout)
	if err != nil {
		r.Error = err.Error()
		return r
	}
	if st.NegotiatedProtocol != "h2" {
		r.Error = "不支持 HTTP/2"
		return r
	}
	if len(st.PeerCertificates) == 0 {
		r.Error = "没有证书"
		return r
	}
	inter := x509.NewCertPool()
	for _, ic := range st.PeerCertificates[1:] {
		inter.AddCert(ic)
	}
	if _, err := st.PeerCertificates[0].Verify(x509.VerifyOptions{DNSName: domain, Intermediates: inter}); err != nil {
		r.Error = "证书无效：" + err.Error()
		return r
	}
	r.OK, r.Ms = true, ms
	return r
}

func checkTargets(domains []string, timeout time.Duration) []TargetResult {
	out := make([]TargetResult, len(domains))
	done := make(chan struct{})
	for i, d := range domains {
		go func(i int, d string) { out[i] = checkTarget(d, timeout); done <- struct{}{} }(i, strings.TrimSpace(d))
	}
	for range domains {
		<-done
	}
	return out
}

// pickTarget 选一个新目标：同网段邻居优先，其次备选大站，都按延迟排序；exclude 里的不要
func pickTarget(selfIP string, candidates []string, exclude map[string]bool) (string, string) {
	if selfIP != "" {
		if hits, err := scanReality(selfIP, 2*time.Second, 48); err == nil {
			for _, h := range hits {
				if !exclude[h.Domain] {
					return h.Domain, "neighbor"
				}
			}
		}
	}
	var ok []TargetResult
	for _, r := range checkTargets(candidates, 6*time.Second) {
		if r.OK && !exclude[r.Domain] {
			ok = append(ok, r)
		}
	}
	sort.Slice(ok, func(i, j int) bool { return ok[i].Ms < ok[j].Ms })
	if len(ok) > 0 {
		return ok[0].Domain, "fallback"
	}
	return "", ""
}

func (a *Agent) loadReality() RealityState {
	var s RealityState
	_ = readJSON(a.path("reality.json"), &s)
	return s
}

func (a *Agent) saveReality(s RealityState) {
	b, _ := json.MarshalIndent(s, "", "  ")
	_ = writeFileAtomic(a.path("reality.json"), b, 0600)
}

// 当前生效的目标：agent 自己换过且 desktop 还没同步过来时，以 agent 的为准
func (a *Agent) realityCurrent() string {
	rc := a.cfg.Reality
	if rc == nil {
		return ""
	}
	s := a.loadReality()
	if s.Override != "" && s.From == rc.SNI {
		return s.Override
	}
	return rc.SNI
}

func (a *Agent) realityLoop() {
	time.Sleep(10 * time.Minute)
	for {
		next := 6 * time.Hour
		if rc := a.cfg.Reality; rc != nil && rc.Mode != "off" && rc.SNI != "" {
			if a.realityCheckOnce() {
				next = 10 * time.Minute // 失败了 10 分钟后复查
			}
		}
		time.Sleep(next)
	}
}

// realityCheckOnce 返回 true 表示这次失败、需要尽快复查
func (a *Agent) realityCheckOnce() bool {
	rc := a.cfg.Reality
	s := a.loadReality()
	cur := a.realityCurrent()
	if s.Override != "" && s.From != rc.SNI {
		s.Override, s.From, s.ChangedAt = "", "", 0 // desktop 已同步了新目标
	}
	s.Current = cur
	s.LastCheck = time.Now().Unix()
	r := checkTarget(cur, 8*time.Second)
	if r.OK {
		s.LastOK, s.Fails, s.LastErr = s.LastCheck, 0, ""
		a.saveReality(s)
		return false
	}
	s.Fails++
	s.LastErr = r.Error
	log.Printf("Reality 目标 %s 检查失败（第 %d 次）：%s", cur, s.Fails, r.Error)
	if s.Fails < 3 {
		a.saveReality(s)
		return true
	}
	if rc.Mode != "auto" {
		a.mu.Lock()
		a.notifyOnce(fmt.Sprintf("reality-bad:%s:%s", cur, time.Now().Format("2006-01-02")), fmt.Sprintf("⚠ Reality 目标 %s 连续 3 次检查失败（%s），节点可能连不上。请在 NodeDeck 里「重新优选 Reality 目标」", cur, r.Error))
		a.mu.Unlock()
		a.saveReality(s)
		return false
	}
	nd, src := pickTarget(rc.SelfIP, rc.Candidates, map[string]bool{cur: true})
	if nd == "" {
		a.mu.Lock()
		a.notifyOnce(fmt.Sprintf("reality-none:%s:%s", cur, time.Now().Format("2006-01-02")), fmt.Sprintf("⚠ Reality 目标 %s 不可用，也没找到能替换的网站（%s）", cur, r.Error))
		a.mu.Unlock()
		a.saveReality(s)
		return false
	}
	if err := a.switchReality(cur, nd); err != nil {
		log.Printf("切换 Reality 目标失败：%v", err)
		s.LastErr = "切换失败：" + err.Error()
		a.saveReality(s)
		return true
	}
	s.Override, s.From, s.ChangedAt, s.Current, s.Fails, s.LastErr = nd, rc.SNI, time.Now().Unix(), nd, 0, ""
	a.saveReality(s)
	how := map[string]string{"neighbor": "同网段邻居", "fallback": "备选大站"}[src]
	a.mu.Lock()
	a.notifyOnce(fmt.Sprintf("reality-switch:%s:%s", cur, nd), fmt.Sprintf("🔁 Reality 目标 %s 不可用（%s），已自动换成%s %s。本机订阅已更新；打开 NodeDeck 会自动同步到其它服务器", cur, r.Error, how, nd))
	a.mu.Unlock()
	return false
}

// switchReality 改 config.full.json 里的 Reality 入站并重载，再改写本机订阅
func (a *Agent) switchReality(old, nd string) error {
	p := a.path("config.full.json")
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	var cfg map[string]any
	if err := json.Unmarshal(b, &cfg); err != nil {
		return err
	}
	found := false
	ins, _ := cfg["inbounds"].([]any)
	for _, x := range ins {
		in, _ := x.(map[string]any)
		tls, _ := in["tls"].(map[string]any)
		re, _ := tls["reality"].(map[string]any)
		if re == nil {
			continue
		}
		tls["server_name"] = nd
		if hs, ok := re["handshake"].(map[string]any); ok {
			hs["server"] = nd
		}
		found = true
	}
	if !found {
		return fmt.Errorf("配置里没有 Reality 入站")
	}
	out, _ := json.MarshalIndent(cfg, "", "  ")
	bak := p + ".bak"
	_ = os.WriteFile(bak, b, 0600)
	if err := writeFileAtomic(p, out, 0600); err != nil {
		return err
	}
	if err := a.apply(true); err != nil {
		_ = writeFileAtomic(p, b, 0600) // 校验不过就还原
		_ = a.apply(true)
		return err
	}
	a.rewriteSubs(old, nd)
	return nil
}

// rewriteSubs 只改这台服务器的 Reality 节点（按公钥识别），其它服务器的节点不动
func (a *Agent) rewriteSubs(old, nd string) {
	pk := ""
	if a.cfg.Reality != nil {
		pk = a.cfg.Reality.PublicKey
	}
	if pk == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for tok, s := range a.subs {
		s.V2ray = rewriteV2ray(s.V2ray, pk, old, nd)
		s.Clash = rewriteLines(s.Clash, pk, old, nd)
		s.Singbox = rewriteSingbox(s.Singbox, pk, nd)
		a.subs[tok] = s
	}
	b, _ := json.Marshal(a.subs)
	_ = writeFileAtomic(a.path("subs.json"), b, 0600)
}

func rewriteLines(text, pk, old, nd string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if strings.Contains(l, pk) {
			lines[i] = strings.ReplaceAll(l, old, nd)
		}
	}
	return strings.Join(lines, "\n")
}

func rewriteV2ray(b64, pk, old, nd string) string {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return b64
	}
	out := rewriteLines(string(raw), pk, "sni="+url.QueryEscape(old), "sni="+url.QueryEscape(nd))
	return base64.StdEncoding.EncodeToString([]byte(out))
}

func rewriteSingbox(js, pk, nd string) string {
	if js == "" {
		return js
	}
	var cfg map[string]any
	if json.Unmarshal([]byte(js), &cfg) != nil {
		return js
	}
	obs, _ := cfg["outbounds"].([]any)
	for _, x := range obs {
		ob, _ := x.(map[string]any)
		tls, _ := ob["tls"].(map[string]any)
		re, _ := tls["reality"].(map[string]any)
		if re != nil && re["public_key"] == pk {
			tls["server_name"] = nd
		}
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return string(b)
}

func checkRealityCmd(domains string) {
	var list []string
	for _, d := range strings.Split(domains, ",") {
		if d = strings.TrimSpace(d); d != "" {
			list = append(list, d)
		}
	}
	b, _ := json.Marshal(checkTargets(list, 6*time.Second))
	fmt.Println(string(b))
}

// pick-reality：部署时用，输出 {"domain","source","hits"}
func pickRealityCmd(selfIP, candidates string) {
	var list []string
	for _, d := range strings.Split(candidates, ",") {
		if d = strings.TrimSpace(d); d != "" {
			list = append(list, d)
		}
	}
	d, src := pickTarget(selfIP, list, map[string]bool{})
	b, _ := json.Marshal(map[string]string{"domain": d, "source": src})
	fmt.Println(string(b))
}
