package main

// Telegram 通知：用户快到期 / 流量快用完 / 被停用、内核升级结果、每日报告
import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type TelegramConfig struct {
	BotToken    string `json:"botToken"`
	ChatID      string `json:"chatId"`
	Daily       bool   `json:"daily"`
	DailyHour   int    `json:"dailyHour"`
	WarnDays    int    `json:"warnDays"`
	WarnPercent int    `json:"warnPercent"`
	APIBase     string `json:"apiBase"` // 测试用，默认 https://api.telegram.org
}

func (a *Agent) tgEnabled() bool { return a.cfg.Telegram.BotToken != "" && a.cfg.Telegram.ChatID != "" }

func (a *Agent) sendTG(text string) error {
	if !a.tgEnabled() {
		return fmt.Errorf("没有配置 Telegram")
	}
	form := url.Values{"chat_id": {a.cfg.Telegram.ChatID}, "text": {text}, "disable_web_page_preview": {"true"}}
	c := &http.Client{Timeout: 20 * time.Second}
	base := a.cfg.Telegram.APIBase
	if base == "" {
		base = "https://api.telegram.org"
	}
	resp, err := c.PostForm(base+"/bot"+a.cfg.Telegram.BotToken+"/sendMessage", form)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var j struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	json.NewDecoder(resp.Body).Decode(&j)
	if !j.OK {
		return fmt.Errorf("Telegram 返回错误：%s", j.Description)
	}
	return nil
}

// notifyOnce 同一个 key 只发一次（调用方需持有 a.mu，发送在后台进行）
func (a *Agent) notifyOnce(key, text string) {
	if !a.tgEnabled() {
		return
	}
	if _, done := a.st.Warned[key]; done {
		return
	}
	a.st.Warned[key] = time.Now().Unix()
	a.dirty = true
	msg := fmt.Sprintf("【%s】%s", a.serverName(), text)
	go func() {
		if err := a.sendTG(msg); err != nil {
			log.Printf("发送 Telegram 通知失败: %v", err)
		}
	}()
}

func (a *Agent) serverName() string {
	if a.cfg.ServerName != "" {
		return a.cfg.ServerName
	}
	return "NodeDeck"
}

func fmtBytes(n int64) string {
	f := float64(n)
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	for f >= 1024 && i < len(units)-1 {
		f /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d B", n)
	}
	return fmt.Sprintf("%.2f %s", f, units[i])
}

var reasonText = map[string]string{"disabled": "已被停用", "expired": "已到期", "quota": "流量已用完"}

// checkNotices 在每次检查时调用（调用方需持有 a.mu）
func (a *Agent) checkNotices(now time.Time, prev, cur map[string]string) {
	if !a.tgEnabled() {
		a.primed = true
		return
	}
	tg := a.cfg.Telegram
	for id, u := range a.users {
		if !u.Notify {
			continue
		}
		used, expire := a.effective(u)
		ps := a.st.PeriodStart[id]
		if reason, off := cur[id]; off {
			if _, was := prev[id]; !was && reason != "disabled" {
				if !a.primed {
					// 启动后第一次检查：只记录已停用的用户，不发通知（避免首次部署刷屏）
					a.st.Warned[fmt.Sprintf("off:%s:%s:%d:%d", id, reason, ps, expire)] = now.Unix()
					continue
				}
				a.notifyOnce(fmt.Sprintf("off:%s:%s:%d:%d", id, reason, ps, expire), fmt.Sprintf("⛔ 用户「%s」%s，已自动停用", u.Name, reasonText[reason]))
			}
			continue
		}
		if tg.WarnDays > 0 && expire > 0 {
			left := expire - now.Unix()
			if left > 0 && left < int64(tg.WarnDays)*86400 {
				a.notifyOnce(fmt.Sprintf("exp:%s:%d", id, expire), fmt.Sprintf("⏰ 用户「%s」将在 %s 到期（还剩 %.1f 天）", u.Name, time.Unix(expire, 0).In(a.loc()).Format("2006-01-02 15:04"), float64(left)/86400))
			}
		}
		if tg.WarnPercent > 0 && u.LimitBytes > 0 && used*100 >= u.LimitBytes*int64(tg.WarnPercent) {
			a.notifyOnce(fmt.Sprintf("quota:%s:%d:%d", id, ps, u.LimitBytes), fmt.Sprintf("📉 用户「%s」流量已用 %d%%（%s / %s）", u.Name, used*100/u.LimitBytes, fmtBytes(used), fmtBytes(u.LimitBytes)))
		}
	}
	a.primed = true
	// 每日报告
	if tg.Daily && a.st.Yesterday.Date != "" && a.st.ReportSent != a.st.Yesterday.Date && now.In(a.loc()).Hour() >= tg.DailyHour {
		y := a.st.Yesterday
		a.st.ReportSent = y.Date
		a.dirty = true
		var off []string
		for id, r := range cur {
			if u, ok := a.users[id]; ok && r != "disabled" {
				off = append(off, fmt.Sprintf("%s（%s）", u.Name, reasonText[r]))
			}
		}
		text := fmt.Sprintf("📊 %s 日报\n流量：%s（上行 %s / 下行 %s）\n活跃用户：%d\n内核：sing-box %s", y.Date, fmtBytes(y.Up+y.Down), fmtBytes(y.Up), fmtBytes(y.Down), y.Active, a.update.Current)
		if len(off) > 0 {
			text += "\n已停用：" + strings.Join(off, "、")
		}
		msg := fmt.Sprintf("【%s】%s", a.serverName(), text)
		go func() {
			if err := a.sendTG(msg); err != nil {
				log.Printf("发送日报失败: %v", err)
			}
		}()
	}
}
