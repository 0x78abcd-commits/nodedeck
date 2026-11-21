package main

// 流量重置周期、首次使用才开始计时、在用状态、每日统计
import (
	"encoding/json"
	"log"
	"time"
	_ "time/tzdata" // VPS 上可能没有时区数据库，内嵌一份
)

type DayStat struct {
	Date   string `json:"date"`
	Up     int64  `json:"up"`
	Down   int64  `json:"down"`
	Active int    `json:"active"`
}

// 需要持久化的运行状态（traffic.json 之外）
type AgentState struct {
	PeriodStart map[string]int64 `json:"periodStart"` // 用户当前计费周期起点（unix 秒）
	LastActive  map[string]int64 `json:"lastActive"`  // 最后有流量的时间
	FirstUsed   map[string]int64 `json:"firstUsed"`   // 第一次有流量的时间
	Warned      map[string]int64 `json:"warned"`      // 已发过的通知（去重）
	Day         DayStat          `json:"day"`         // 今天累计
	DayActive   map[string]bool  `json:"dayActive"`
	Yesterday   DayStat          `json:"yesterday"`
	ReportSent  string           `json:"reportSent"` // 已发日报的日期
}

func newState() AgentState {
	return AgentState{PeriodStart: map[string]int64{}, LastActive: map[string]int64{}, FirstUsed: map[string]int64{}, Warned: map[string]int64{}, DayActive: map[string]bool{}}
}

func (a *Agent) loc() *time.Location {
	if a.cfg.Timezone != "" {
		if l, err := time.LoadLocation(a.cfg.Timezone); err == nil {
			return l
		}
	}
	return time.FixedZone("CST", 8*3600)
}

func (a *Agent) loadState() {
	st := newState()
	_ = readJSON(a.path("state.json"), &st)
	if st.PeriodStart == nil {
		st.PeriodStart = map[string]int64{}
	}
	if st.LastActive == nil {
		st.LastActive = map[string]int64{}
	}
	if st.FirstUsed == nil {
		st.FirstUsed = map[string]int64{}
	}
	if st.Warned == nil {
		st.Warned = map[string]int64{}
	}
	if st.DayActive == nil {
		st.DayActive = map[string]bool{}
	}
	a.st = st
}

// 调用方需持有 a.mu
func (a *Agent) stateBytes() []byte {
	b, _ := json.Marshal(a.st)
	return b
}

// periodStart 计算用户当前计费周期的起点；不重置返回 0
func periodStart(u User, now time.Time, loc *time.Location) int64 {
	t := now.In(loc)
	switch u.ResetPeriod {
	case "day":
		return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc).Unix()
	case "week":
		wd := (int(t.Weekday()) + 6) % 7 // 周一为 0
		return time.Date(t.Year(), t.Month(), t.Day()-wd, 0, 0, 0, 0, loc).Unix()
	case "month":
		day := u.ResetDay
		if day < 1 || day > 28 {
			day = 1
		}
		d := time.Date(t.Year(), t.Month(), day, 0, 0, 0, 0, loc)
		if d.After(t) {
			d = d.AddDate(0, -1, 0)
		}
		return d.Unix()
	case "rolling30":
		if u.ResetAnchor <= 0 {
			return 0
		}
		n := (now.Unix() - u.ResetAnchor) / (30 * 86400)
		if n < 0 {
			n = 0
		}
		return u.ResetAnchor + n*30*86400
	}
	return 0
}

// rollPeriods 到了新周期就清零该用户流量（调用方需持有 a.mu）
func (a *Agent) rollPeriods(now time.Time) {
	loc := a.loc()
	for id, u := range a.users {
		ps := periodStart(u, now, loc)
		if ps == 0 {
			continue
		}
		old, seen := a.st.PeriodStart[id]
		if !seen {
			a.st.PeriodStart[id] = ps
			a.dirty = true
			continue
		}
		if ps > old {
			delete(a.traffic, id)
			a.st.PeriodStart[id] = ps
			a.dirty = true
			log.Printf("用户 %s 进入新的流量周期，已清零", u.Name)
		}
	}
}

// rollDay 跨天时把今天的统计存为昨天（调用方需持有 a.mu）
func (a *Agent) rollDay(now time.Time) {
	today := now.In(a.loc()).Format("2006-01-02")
	if a.st.Day.Date == today {
		return
	}
	if a.st.Day.Date != "" {
		a.st.Day.Active = len(a.st.DayActive)
		a.st.Yesterday = a.st.Day
	}
	a.st.Day = DayStat{Date: today}
	a.st.DayActive = map[string]bool{}
	a.dirty = true
}

// effective 返回用户本周期已用流量和实际到期时间（调用方需持有 a.mu）
func (a *Agent) effective(u User) (used int64, expire int64) {
	base := u.BaseUsed
	if ps := a.st.PeriodStart[u.ID]; ps > 0 && u.BaseUsedAt < ps {
		base = 0 // 其他服务器的用量是上个周期的快照，已作废
	}
	used = base
	if t := a.traffic[u.ID]; t != nil {
		used += t.Up + t.Down
	}
	expire = u.ExpireAt
	if u.ExpireAfterDays > 0 {
		first := u.FirstUsedAt
		if lf := a.st.FirstUsed[u.ID]; lf > 0 && (first == 0 || lf < first) {
			first = lf
		}
		if first > 0 {
			expire = first + int64(u.ExpireAfterDays)*86400
		} else {
			expire = 0 // 还没用过，不计时
		}
	}
	return
}

// markActive 记录用户有流量（调用方需持有 a.mu）
func (a *Agent) markActive(id string, up, down int64, now int64) {
	a.st.LastActive[id] = now
	if a.st.FirstUsed[id] == 0 {
		a.st.FirstUsed[id] = now
	}
	a.st.Day.Up += up
	a.st.Day.Down += down
	a.st.DayActive[id] = true
}
