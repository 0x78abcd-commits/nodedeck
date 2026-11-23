package main

// 运维告警（Telegram）：sing-box 挂了（先自动拉起）、磁盘快满、CPU 持续过高、三网延迟明显变差
import (
	"fmt"
	"sort"
	"syscall"
	"time"
)

type AlertCfg struct {
	Off       bool `json:"off"`
	DiskPct   int  `json:"diskPct"`   // 默认 90
	CPUPct    int  `json:"cpuPct"`    // 默认 90，连续 15 分钟
	LatencyMs int  `json:"latencyMs"` // 默认 300，三网平均连续 15 分钟高于它且比 24 小时中位数高一倍
}

func (a *Agent) alertCfg() AlertCfg {
	c := a.cfg.Alerts
	if c.DiskPct <= 0 {
		c.DiskPct = 90
	}
	if c.CPUPct <= 0 {
		c.CPUPct = 90
	}
	if c.LatencyMs <= 0 {
		c.LatencyMs = 300
	}
	return c
}

func diskPct(path string) float64 {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil || st.Blocks == 0 {
		return 0
	}
	return 100 * float64(st.Blocks-st.Bavail) / float64(st.Blocks)
}

func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return s[len(s)/2]
}

func avgLat(s Sample) (float64, bool) {
	sum, n := 0.0, 0
	for _, v := range s.Lat {
		if v > 0 {
			sum += v
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

// checkAlerts 每分钟调用一次（在 metricsLoop 里）
func (a *Agent) checkAlerts(now time.Time) {
	if !a.tgEnabled() || a.cfg.Alerts.Off {
		return
	}
	c := a.alertCfg()
	day := now.Format("2006-01-02")

	// 1. sing-box 服务
	if a.cfg.Service != "" && !a.svcActive(a.cfg.Service) {
		err := a.svcRestart(a.cfg.Service)
		time.Sleep(3 * time.Second)
		ok := a.svcActive(a.cfg.Service)
		a.mu.Lock()
		if ok {
			a.notifyOnce("svc-restart:"+now.Format("2006-01-02T15"), "⚠ sing-box 服务停止了，已自动重启恢复")
		} else {
			a.notifyOnce("svc-down:"+now.Format("2006-01-02T15"), fmt.Sprintf("🔴 sing-box 服务停止且自动重启失败（%v），所有节点不可用，请在 NodeDeck 里查看日志", err))
		}
		a.mu.Unlock()
	}

	// 2. 磁盘
	if p := diskPct("/"); p >= float64(c.DiskPct) {
		a.mu.Lock()
		a.notifyOnce("disk:"+day, fmt.Sprintf("💾 系统盘已用 %.0f%%，快满了（满了会导致流量统计和日志写不进去）", p))
		a.mu.Unlock()
	}

	// 3. CPU / 延迟：看最近 15 分钟
	m := a.metrics
	if m == nil {
		return
	}
	m.mu.Lock()
	mins := append([]Sample(nil), m.Minutes...)
	m.mu.Unlock()
	if len(mins) < 15 {
		return
	}
	recent := mins[len(mins)-15:]
	high := true
	for _, s := range recent {
		if s.CPU < float64(c.CPUPct) {
			high = false
			break
		}
	}
	if high {
		a.mu.Lock()
		a.notifyOnce("cpu:"+now.Format("2006-01-02T15"), fmt.Sprintf("🔥 CPU 已经连续 15 分钟高于 %d%%，可能被滥用或机器超售", c.CPUPct))
		a.mu.Unlock()
	}
	var base, cur []float64
	for i, s := range mins {
		if v, ok := avgLat(s); ok {
			if i >= len(mins)-15 {
				cur = append(cur, v)
			} else {
				base = append(base, v)
			}
		}
	}
	if len(cur) >= 2 && len(base) >= 30 {
		mc, mb := median(cur), median(base)
		if mc > float64(c.LatencyMs) && mc > 2*mb {
			a.mu.Lock()
			a.notifyOnce("lat:"+now.Format("2006-01-02T15"), fmt.Sprintf("🐢 到国内三网的延迟变差：最近 %.0fms，平时 %.0fms（可能线路拥堵或被限速）", mc, mb))
			a.mu.Unlock()
		}
	}
}
