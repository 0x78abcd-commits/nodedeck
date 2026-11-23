package main

import (
	"testing"
	"time"
)

func TestPeriodStart(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	now := time.Date(2026, 11, 22, 10, 30, 0, 0, loc) // 周日
	cases := []struct {
		u    User
		want time.Time
	}{
		{User{ResetPeriod: "day"}, time.Date(2026, 11, 22, 0, 0, 0, 0, loc)},
		{User{ResetPeriod: "week"}, time.Date(2026, 11, 16, 0, 0, 0, 0, loc)},
		{User{ResetPeriod: "month", ResetDay: 1}, time.Date(2026, 11, 1, 0, 0, 0, 0, loc)},
		{User{ResetPeriod: "month", ResetDay: 25}, time.Date(2026, 10, 25, 0, 0, 0, 0, loc)},
		{User{ResetPeriod: "month", ResetDay: 22}, time.Date(2026, 11, 22, 0, 0, 0, 0, loc)},
	}
	for _, c := range cases {
		if got := periodStart(c.u, now, loc); got != c.want.Unix() {
			t.Errorf("%s/%d: got %v want %v", c.u.ResetPeriod, c.u.ResetDay, time.Unix(got, 0).In(loc), c.want)
		}
	}
	anchor := time.Date(2026, 9, 1, 12, 0, 0, 0, loc).Unix()
	got := periodStart(User{ResetPeriod: "rolling30", ResetAnchor: anchor}, now, loc)
	if want := anchor + 2*30*86400; got != want {
		t.Errorf("rolling30: got %v want %v", time.Unix(got, 0).In(loc), time.Unix(want, 0).In(loc))
	}
	if periodStart(User{ResetPeriod: "none"}, now, loc) != 0 {
		t.Error("none should be 0")
	}
}

func TestEffective(t *testing.T) {
	a := &Agent{traffic: map[string]*Traffic{"u1": {Up: 100, Down: 200}}, st: newState()}
	a.st.PeriodStart["u1"] = 1000
	// 其他服务器用量快照早于本周期起点 → 作废
	used, _ := a.effective(User{ID: "u1", BaseUsed: 5000, BaseUsedAt: 999})
	if used != 300 {
		t.Errorf("stale base: used=%d", used)
	}
	used, _ = a.effective(User{ID: "u1", BaseUsed: 5000, BaseUsedAt: 1001})
	if used != 5300 {
		t.Errorf("fresh base: used=%d", used)
	}
	// 首次使用后 30 天
	_, exp := a.effective(User{ID: "u2", ExpireAfterDays: 30})
	if exp != 0 {
		t.Errorf("未使用不应计时: %d", exp)
	}
	a.st.FirstUsed["u2"] = 2000
	_, exp = a.effective(User{ID: "u2", ExpireAfterDays: 30})
	if exp != 2000+30*86400 {
		t.Errorf("首次使用计时: %d", exp)
	}
	_, exp = a.effective(User{ID: "u2", ExpireAfterDays: 30, FirstUsedAt: 1500})
	if exp != 1500+30*86400 {
		t.Errorf("取更早的首次使用: %d", exp)
	}
}

func TestInWindow(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	a := &Agent{cfg: Config{Timezone: "Asia/Shanghai", UpgradeWindow: []int{3, 5}}}
	at := func(h int) time.Time { return time.Date(2026, 11, 22, h, 0, 0, 0, loc) }
	if !a.inWindow(at(3)) || !a.inWindow(at(4)) || a.inWindow(at(5)) || a.inWindow(at(12)) {
		t.Error("3-5 窗口判断错误")
	}
	a.cfg.UpgradeWindow = []int{23, 2}
	if !a.inWindow(at(23)) || !a.inWindow(at(1)) || a.inWindow(at(2)) || a.inWindow(at(12)) {
		t.Error("跨零点窗口判断错误")
	}
	a.cfg.UpgradeWindow = nil
	if !a.inWindow(at(12)) {
		t.Error("未设置窗口应随时可升级")
	}
}

func TestDetectFormat(t *testing.T) {
	cases := map[string]string{
		"ClashMetaForAndroid/2.11": "clash", "mihomo/1.19": "clash", "SFA/1.12.0 (sing-box 1.12.0)": "singbox",
		"v2rayN/7.0": "v2ray", "Shadowrocket/2000": "shadowrocket", "HiddifyNext/2.5": "v2ray",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130": "html",
	}
	for ua, want := range cases {
		r := httptestReq(ua)
		if got := detectFormat(r); got != want {
			t.Errorf("%s: got %s want %s", ua, got, want)
		}
	}
}
