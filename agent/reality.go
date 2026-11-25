package main

// Reality 目标巡检：定期检查当前「偷」的网站还能不能用（TLS 1.3 + HTTP/2 + X25519 + 证书有效）。
// 连续失败 3 次（间隔 10 分钟）后：mode=auto 自动换一个新目标（先扫同网段邻居，再试备选大站），
// 同时改写本机订阅里这台服务器的节点并发 Telegram 通知；mode=notify 只通知；off 不检查。
import (
	"crypto/tls"
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

type CheckItem struct {
	Name  string `json:"name"`
	OK    bool   `json:"ok"`
	Value string `json:"value"`
}

type TargetResult struct {
	Domain string      `json:"domain"`
	OK     bool        `json:"ok"`
	Ms     int64       `json:"ms"`
	IP     string      `json:"ip,omitempty"` // 目标网站实际连到的 IP（和 VPS 是否同网段）
	Checks []CheckItem `json:"checks,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// checkTarget 检查一个网站能不能做 Reality 目标，四项都要通过（和桌面端本机检测同一标准）：
// TLS 1.3、HTTP/2（ALPN h2）、X25519 密钥交换、证书对这个域名有效。
// 先不加限制握手一次拿到版本 / ALPN / 证书，再只允许 TLS 1.3 + X25519 握手一次确认密钥交换。
func checkTarget(domain string, timeout time.Duration) TargetResult {
	r := TargetResult{Domain: domain}
	addr := net.JoinHostPort(domain, targetPort)
	st, ms, ip, err := tlsProbeOpen(addr, domain, timeout)
	if err != nil {
		r.Error = "连接失败：" + err.Error()
		return r
	}
	r.Ms, r.IP = ms, ip
	ver := map[uint16]string{tls.VersionTLS10: "TLS 1.0", tls.VersionTLS11: "TLS 1.1", tls.VersionTLS12: "TLS 1.2", tls.VersionTLS13: "TLS 1.3"}[st.Version]
	alpn := st.NegotiatedProtocol
	if alpn == "" {
		alpn = "无"
	}
	x := CheckItem{Name: "X25519", Value: "需要先支持 TLS 1.3"}
	if st.Version == tls.VersionTLS13 {
		if _, ms2, err := tlsProbe(addr, domain, timeout); err == nil {
			x.OK, x.Value = true, "支持"
			r.Ms = ms2
		} else {
			x.Value = "不支持（" + err.Error() + "）"
		}
	}
	certItem := CheckItem{Name: "证书有效", Value: "没有证书"}
	if len(st.PeerCertificates) > 0 {
		inter := x509.NewCertPool()
		for _, ic := range st.PeerCertificates[1:] {
			inter.AddCert(ic)
		}
		leaf := st.PeerCertificates[0]
		if _, err := leaf.Verify(x509.VerifyOptions{DNSName: domain, Intermediates: inter}); err != nil {
			certItem.Value = err.Error()
		} else {
			certItem.OK = true
			certItem.Value = "到期 " + leaf.NotAfter.Format("2006-01-02")
			if len(leaf.Issuer.Organization) > 0 {
				certItem.Value = leaf.Issuer.Organization[0] + "，" + certItem.Value
			}
		}
	}
	r.Checks = []CheckItem{
		{Name: "TLS 1.3", OK: st.Version == tls.VersionTLS13, Value: ver},
		{Name: "HTTP/2", OK: st.NegotiatedProtocol == "h2", Value: alpn},
		x,
		certItem,
	}
	r.OK = true
	var bad []string
	for _, c := range r.Checks {
		if !c.OK {
			r.OK = false
			bad = append(bad, c.Name)
		}
	}
	if !r.OK {
		r.Error = "不满足：" + strings.Join(bad, "、")
	}
	return r
}

// 目标网站端口（测试时会改）
var targetPort = "443"

// 不限制版本和曲线的握手，只用来读取对方支持什么
func tlsProbeOpen(addr, sni string, timeout time.Duration) (*tls.ConnectionState, int64, string, error) {
	d := &net.Dialer{Timeout: timeout}
	cfg := &tls.Config{ServerName: sni, InsecureSkipVerify: true, NextProtos: []string{"h2", "http/1.1"}, MinVersion: tls.VersionTLS12}
	t0 := time.Now()
	c, err := tls.DialWithDialer(d, "tcp", addr, cfg)
	if err != nil {
		return nil, 0, "", err
	}
	defer c.Close()
	st := c.ConnectionState()
	ip := ""
	if ta, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		ip = ta.IP.String()
	}
	return &st, time.Since(t0).Milliseconds(), ip, nil
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

// 在国内按域名（SNI）屏蔽的网站：拿来当 Reality 目标，客户端一连就被掐断。和桌面端 core.js 的 SNI_BLOCKED 一致
var blockedSNI = []string{"google.com", "googleapis.com", "gstatic.com", "googlevideo.com", "youtube.com", "ytimg.com", "facebook.com", "fbcdn.net", "instagram.com", "whatsapp.com", "whatsapp.net", "twitter.com", "x.com", "twimg.com", "telegram.org", "t.me", "wikipedia.org", "wikimedia.org", "netflix.com", "reddit.com", "discord.com", "discord.gg", "pinterest.com", "dropbox.com", "openai.com", "chatgpt.com", "blogspot.com", "nytimes.com", "medium.com", "github.io", "pornhub.com", "xvideos.com", "onlyfans.com", "bbc.com", "voanews.com", "rfa.org", "theepochtimes.com", "ntdtv.com"}

func sniBlocked(d string) bool {
	d = strings.ToLower(strings.TrimSuffix(d, "."))
	for _, b := range blockedSNI {
		if d == b || strings.HasSuffix(d, "."+b) {
			return true
		}
	}
	return false
}

type targetCand struct {
	Domain string `json:"domain"`
	Source string `json:"source"` // neighbor / fallback
	Ms     int64  `json:"ms"`
}

// rankTargets 候选目标按优先顺序排好：同网段邻居（按延迟）在前，备选大站（按延迟）在后；国内屏蔽的和 exclude 里的不要
func rankTargets(selfIP string, candidates []string, exclude map[string]bool) []targetCand {
	var out []targetCand
	if selfIP != "" {
		if hits, err := scanReality(selfIP, 2*time.Second, 48); err == nil {
			for _, h := range hits {
				if !exclude[h.Domain] && !sniBlocked(h.Domain) {
					out = append(out, targetCand{h.Domain, "neighbor", h.Ms})
					if len(out) >= 8 {
						break
					}
				}
			}
		}
	}
	var ok []TargetResult
	for _, r := range checkTargets(candidates, 6*time.Second) {
		if r.OK && !exclude[r.Domain] && !sniBlocked(r.Domain) {
			ok = append(ok, r)
		}
	}
	sort.Slice(ok, func(i, j int) bool { return ok[i].Ms < ok[j].Ms })
	for _, r := range ok {
		out = append(out, targetCand{r.Domain, "fallback", r.Ms})
	}
	return out
}

// pickTarget 选一个新目标（VPS 自己巡检换目标时用）
func pickTarget(selfIP string, candidates []string, exclude map[string]bool) (string, string) {
	if l := rankTargets(selfIP, candidates, exclude); len(l) > 0 {
		return l[0].Domain, l[0].Source
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
	// XHTTP-Reality（Xray）和 VLESS-Reality 共用目标，一起换
	xp := a.path("xray.full.json")
	xb, xerr := os.ReadFile(xp)
	var xout []byte
	if xerr == nil {
		if o, ok := switchXrayReality(xb, nd); ok {
			xout = o
			found = true
		}
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
	if xout != nil {
		if err := writeFileAtomic(xp, xout, 0600); err != nil {
			_ = writeFileAtomic(p, b, 0600)
			return err
		}
	}
	if err := a.apply(true); err != nil {
		_ = writeFileAtomic(p, b, 0600) // 校验不过就还原
		if xout != nil {
			_ = writeFileAtomic(xp, xb, 0600)
		}
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
		s.ClashLegacy = rewriteLines(s.ClashLegacy, pk, old, nd)
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

// pick-reality：部署时用，输出 {"domain","source","list"}；list 是按优先顺序的全部候选，桌面端会再从国内测一遍
func pickRealityCmd(selfIP, candidates string) {
	var list []string
	for _, d := range strings.Split(candidates, ",") {
		if d = strings.TrimSpace(d); d != "" {
			list = append(list, d)
		}
	}
	l := rankTargets(selfIP, list, map[string]bool{})
	res := map[string]any{"domain": "", "source": "", "list": l}
	if len(l) > 0 {
		res["domain"], res["source"] = l[0].Domain, l[0].Source
	}
	b, _ := json.Marshal(res)
	fmt.Println(string(b))
}

// switchXrayReality 把 Xray 配置里 Reality 入站的目标换成 nd；没有 Reality 入站返回 false
func switchXrayReality(b []byte, nd string) ([]byte, bool) {
	var cfg map[string]any
	if json.Unmarshal(b, &cfg) != nil {
		return nil, false
	}
	found := false
	ins, _ := cfg["inbounds"].([]any)
	for _, x := range ins {
		in, _ := x.(map[string]any)
		ss, _ := in["streamSettings"].(map[string]any)
		rs, _ := ss["realitySettings"].(map[string]any)
		if rs == nil {
			continue
		}
		rs["target"] = nd + ":443"
		delete(rs, "dest")
		rs["serverNames"] = []any{nd}
		found = true
	}
	if !found {
		return nil, false
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	return out, err == nil
}
