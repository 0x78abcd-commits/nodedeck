package main

// 微信推送：Server 酱（Turbo 版 sctapi.ftqq.com，和 Server 酱³ push.ft07.com，按 SendKey 自动区分）和 PushPlus。
// 和 Telegram 一样由 VPS 直接发；配了几个就发几个，国内手机不用开代理也能收到。
import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type WechatConfig struct {
	ServerChan string `json:"serverchan"` // Server 酱 SendKey
	PushPlus   string `json:"pushplus"`   // PushPlus token
	// 测试用，默认官方地址
	ServerChanAPI string `json:"serverchanApi,omitempty"`
	PushPlusAPI   string `json:"pushplusApi,omitempty"`
}

var notifyHTTP = &http.Client{Timeout: 20 * time.Second}

func (a *Agent) wechatOn() bool { return a.cfg.Wechat.ServerChan != "" || a.cfg.Wechat.PushPlus != "" }

// notifyOn 至少配了一个通知渠道
func (a *Agent) notifyOn() bool { return a.tgEnabled() || a.wechatOn() }

// notifyTitle 微信推送的标题：第一行，去掉【服务器名】前缀后的部分太短就整行用，最多 32 个字
func notifyTitle(text string) string {
	t := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	if r := []rune(t); len(r) > 32 {
		t = string(r[:32]) + "…"
	}
	if t == "" {
		t = "NodeDeck 通知"
	}
	return t
}

var sc3Re = regexp.MustCompile(`^sctp(\d+)t`)

func serverChanURL(key, api string) string {
	if api != "" {
		return strings.TrimRight(api, "/") + "/" + key + ".send"
	}
	if m := sc3Re.FindStringSubmatch(key); m != nil {
		return fmt.Sprintf("https://%s.push.ft07.com/send/%s.send", m[1], key)
	}
	return "https://sctapi.ftqq.com/" + key + ".send"
}

func sendServerChan(key, api, text string) error {
	form := url.Values{"title": {notifyTitle(text)}, "desp": {strings.ReplaceAll(text, "\n", "\n\n")}}
	resp, err := notifyHTTP.PostForm(serverChanURL(key, api), form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var j struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &j) != nil {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if j.Code != 0 {
		return fmt.Errorf("%s（code %d）", j.Message, j.Code)
	}
	return nil
}

func sendPushPlus(token, api, text string) error {
	if api == "" {
		api = "https://www.pushplus.plus/send"
	}
	body, _ := json.Marshal(map[string]string{"token": token, "title": notifyTitle(text), "content": text, "template": "txt"})
	resp, err := notifyHTTP.Post(api, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var j struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	if json.Unmarshal(b, &j) != nil {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if j.Code != 200 {
		return fmt.Errorf("%s（code %d）", j.Msg, j.Code)
	}
	return nil
}

// sendAll 发到所有配了的渠道；有渠道失败就返回错误（写明哪个渠道），其它渠道照发
func (a *Agent) sendAll(text string) error {
	if !a.notifyOn() {
		return errors.New("没有配置任何通知渠道（Telegram / Server 酱 / PushPlus）")
	}
	var errs []string
	if a.tgEnabled() {
		if err := a.sendTG(text); err != nil {
			errs = append(errs, "Telegram："+err.Error())
		}
	}
	if k := a.cfg.Wechat.ServerChan; k != "" {
		if err := sendServerChan(k, a.cfg.Wechat.ServerChanAPI, text); err != nil {
			errs = append(errs, "Server 酱："+err.Error())
		}
	}
	if k := a.cfg.Wechat.PushPlus; k != "" {
		if err := sendPushPlus(k, a.cfg.Wechat.PushPlusAPI, text); err != nil {
			errs = append(errs, "PushPlus："+err.Error())
		}
	}
	if len(errs) > 0 {
		err := errors.New(strings.Join(errs, "；"))
		log.Printf("发送通知: %v", err)
		return err
	}
	return nil
}
