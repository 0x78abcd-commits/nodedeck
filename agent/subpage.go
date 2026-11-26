package main

// 订阅：按客户端自动选择格式；浏览器打开时显示订阅信息页
import (
	"encoding/base64"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// detectFormat 根据 ?format= 或 User-Agent 判断返回哪种订阅
func detectFormat(r *http.Request) string {
	if f := r.URL.Query().Get("format"); f != "" {
		return f
	}
	ua := strings.ToLower(r.UserAgent())
	switch {
	case strings.Contains(ua, "clash") || strings.Contains(ua, "mihomo") || strings.Contains(ua, "stash"):
		return "clash"
	case strings.Contains(ua, "shadowrocket"):
		return "shadowrocket"
	case strings.Contains(ua, "sing-box") || strings.Contains(ua, "sfa/") || strings.Contains(ua, "sfi/") || strings.Contains(ua, "sfm/") || strings.Contains(ua, "sft/"):
		return "singbox"
	case strings.Contains(ua, "mozilla") && !strings.Contains(ua, "v2ray") && !strings.Contains(ua, "hiddify") && !strings.Contains(ua, "nekobox") && !strings.Contains(ua, "shadowrocket") && !strings.Contains(ua, "quantumult") && !strings.Contains(ua, "surge"):
		return "html"
	}
	return "v2ray"
}

type pageData struct {
	Name, Status, StatusClass, Used, Total, Expire, Updated, SubURL string
	QR                                                              template.URL
	Percent                                                         int
	Imports                                                         []pageLink
}

type pageLink struct {
	Name string
	URL  template.URL
}

var pageTpl = template.Must(template.New("p").Parse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>{{.Name}} 的订阅</title>
<style>body{margin:0;background:#0b1020;color:#dfe6f7;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}.w{max-width:480px;margin:0 auto;padding:24px 16px}.c{background:#121a30;border:1px solid #24304f;border-radius:12px;padding:18px;margin-bottom:14px}h1{font-size:20px;margin:0 0 4px}.m{color:#8592b3;font-size:13px}.t{display:inline-block;padding:2px 10px;border-radius:99px;font-size:13px;border:1px solid}.ok{color:#3ccf8e}.bad{color:#ef5b6b}.warn{color:#f2a93b}.bar{height:8px;background:#17213d;border-radius:99px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:#22c3a6}.kv{display:grid;grid-template-columns:80px 1fr;gap:6px}.k{color:#8592b3}img{display:block;margin:0 auto;background:#fff;border-radius:8px;padding:6px;width:220px}input{width:100%;box-sizing:border-box;background:#0d1428;color:#dfe6f7;border:1px solid #24304f;border-radius:8px;padding:8px}summary{cursor:pointer}details p{margin:8px 0 0}a.b,button{display:block;text-align:center;background:#17213d;color:#dfe6f7;border:1px solid #24304f;border-radius:8px;padding:10px;margin-top:8px;text-decoration:none;font:inherit;width:100%;cursor:pointer}button{background:#4f8cff;border-color:#4f8cff;color:#fff}</style></head><body><div class="w">
<div class="c"><h1>{{.Name}}</h1><span class="t {{.StatusClass}}">{{.Status}}</span>
<div class="bar"><i style="width:{{.Percent}}%"></i></div>
<div class="kv"><div class="k">已用</div><div>{{.Used}} / {{.Total}}</div><div class="k">到期</div><div>{{.Expire}}</div></div>
<p class="m">更新于 {{.Updated}}</p></div>
<div class="c">{{if .QR}}<img src="{{.QR}}" alt="订阅二维码">{{end}}<p class="m" style="text-align:center">手机客户端扫码添加订阅</p>
<input id="u" value="{{.SubURL}}" readonly><button onclick="navigator.clipboard.writeText(document.getElementById('u').value).then(()=>this.textContent='已复制 ✔')">复制订阅地址</button></div>
<div class="c"><b>一键导入</b><p class="m">已安装对应客户端时点击即可；v2rayN 请复制地址后在「订阅分组」里添加。</p>{{range .Imports}}<a class="b" href="{{.URL}}">{{.Name}}</a>{{end}}</div>
<details class="c"><summary><b>防止 DNS / 真实 IP 泄露</b></summary>
<p class="m">最省事：客户端打开「TUN / VPN 模式」（v2rayNG、sing-box、Hiddify 默认就是），所有流量包括浏览器的 WebRTC 都走代理。</p>
<p class="m"><b>Clash Verge / FlClash / Clash Meta</b>：订阅里已配好防泄露的 DNS。不要开客户端的「DNS 覆写」；要防 WebRTC 就打开「虚拟网卡 / TUN 模式」。</p>
<p class="m"><b>sing-box（SFA / SFI / SFM）</b>：订阅里已配好，打开 VPN 即可。</p>
<p class="m"><b>v2rayNG</b>：设置里「远程 DNS」填 https://1.1.1.1/dns-query，「国内 DNS」填 223.5.5.5，打开「启用本地 DNS」；路由选「绕过局域网及大陆地址」。</p>
<p class="m"><b>v2rayN</b>：系统代理模式下浏览器 WebRTC 不走代理，要防就打开 TUN 模式。</p>
<p class="m"><b>浏览器</b>：Chrome 装 uBlock Origin，在它的设置里勾「防止 WebRTC 泄露本地 IP 地址」；Firefox 在 about:config 把 media.peerconnection.enabled 改成 false（网页视频通话会用不了）。</p>
<p class="m"><b>自查</b>：打开 ipleak.net，显示的 IP 和 DNS 服务器都应该在节点所在的国家，不应出现你本地运营商。</p></details>
<p class="m" style="text-align:center">请勿分享此页面链接</p></div></body></html>`))

func (a *Agent) renderSubPage(w http.ResponseWriter, r *http.Request, s Sub, used, total, expire int64, reason string) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	subURL := s.URL
	if subURL == "" {
		subURL = scheme + "://" + r.Host + r.URL.Path
	}
	name := url.QueryEscape(s.Name)
	d := pageData{Name: s.Name, SubURL: subURL, Used: fmtBytes(used), Total: "不限", Expire: "永久", Updated: time.Now().In(a.loc()).Format("2006-01-02 15:04")}
	// 二维码是 NodeDeck 生成的 PNG data URL，只放行这种格式
	if strings.HasPrefix(s.QR, "data:image/png;base64,") {
		d.QR = template.URL(s.QR)
	}
	if total > 0 {
		d.Total = fmtBytes(total)
		d.Percent = int(used * 100 / total)
		if d.Percent > 100 {
			d.Percent = 100
		}
	}
	if expire > 0 {
		left := float64(expire-time.Now().Unix()) / 86400
		d.Expire = time.Unix(expire, 0).In(a.loc()).Format("2006-01-02")
		if left > 0 {
			d.Expire += fmt.Sprintf("（还剩 %.1f 天）", left)
		}
	} else if s.ExpireAfterDays > 0 {
		d.Expire = fmt.Sprintf("首次使用后 %d 天", s.ExpireAfterDays)
	}
	switch reason {
	case "":
		d.Status, d.StatusClass = "正常", "ok"
	case "expired":
		d.Status, d.StatusClass = "已到期", "bad"
	case "quota":
		d.Status, d.StatusClass = "流量已用完", "bad"
	default:
		d.Status, d.StatusClass = "已停用", "bad"
	}
	enc := url.QueryEscape(subURL)
	d.Imports = []pageLink{
		{"Clash Verge / Mihomo", template.URL("clash://install-config?url=" + url.QueryEscape(subURL+"?format=clash") + "&name=" + name)},
		{"sing-box（SFA / SFI / SFM）", template.URL("sing-box://import-remote-profile?url=" + url.QueryEscape(subURL+"?format=singbox") + "#" + name)},
		{"Shadowrocket（小火箭）", template.URL("sub://" + base64.StdEncoding.EncodeToString([]byte(subURL)) + "#" + name)},
		{"Hiddify", template.URL("hiddify://import/" + subURL + "#" + name)},
		{"NekoBox / v2rayNG", template.URL("v2rayng://install-config?url=" + enc + "&name=" + name)},
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	pageTpl.Execute(w, d)
}
