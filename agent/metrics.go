package main

// 服务器监控：CPU、内存、磁盘、网速、负载、三网延迟，保留 24 小时分钟级 + 30 天小时级数据；本月流量
import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Sample struct {
	T    int64              `json:"t"`
	CPU  float64            `json:"cpu"`  // %
	Mem  float64            `json:"mem"`  // %
	Rx   float64            `json:"rx"`   // 字节/秒
	Tx   float64            `json:"tx"`   // 字节/秒
	Load float64            `json:"load"` // 1 分钟负载
	Lat  map[string]float64 `json:"lat,omitempty"`
	// 0.7.0 起：三网丢包率（%）和抖动（ms）、TCP 重传率（%）、TCP 连接数
	Loss map[string]float64 `json:"loss,omitempty"`
	Jit  map[string]float64 `json:"jit,omitempty"`
	Retr float64            `json:"retr"`
	Conn int                `json:"conn"`
	// 0.9.2 起：CPU 被宿主机占用（steal，超售时明显）、代理流量（所有用户合计，字节/秒：用户下载 / 上传）
	Steal float64 `json:"steal"`
	PDown float64 `json:"pdown"`
	PUp   float64 `json:"pup"`
}

type MonthTraffic struct {
	Month  string `json:"month"`
	Rx     int64  `json:"rx"`
	Tx     int64  `json:"tx"`
	LastRx uint64 `json:"lastRx"`
	LastTx uint64 `json:"lastTx"`
	// 从哪天开始统计（agent 是月中装上的；整月都在统计时为 0）
	Since int64 `json:"since,omitempty"`
}

type Metrics struct {
	mu        sync.Mutex
	Minutes   []Sample     `json:"minutes"`
	Hours     []Sample     `json:"hours"`
	Month     MonthTraffic `json:"month"`
	lastCPU   [2]uint64
	lastNet   [2]uint64
	lastT     time.Time
	lastLat   map[string]float64
	lastLoss  map[string]float64
	lastJit   map[string]float64
	lastSNMP  [2]uint64
	lastSyn   uint64
	lastSteal uint64
	lastProxy [2]int64
	hourBuf   []Sample
	hourMark  int64
}

// 默认三网测试目标：广东电信 / 联通 / 移动的公共 DNS（ICMP）
var defaultLatTargets = map[string]string{"电信": "202.96.128.86", "联通": "221.5.88.88", "移动": "211.136.192.6"}

func readCPU() (idle, total uint64) {
	idle, total, _ = readCPUSteal()
	return
}

// readCPUSteal 读 /proc/stat 第一行：user nice system idle iowait irq softirq steal guest guest_nice。
// guest 已经算在 user / nice 里，不能再加一次（和 top / htop 一样）；steal 是宿主机拿走的时间，单独给出来。
func readCPUSteal() (idle, total, steal uint64) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return
	}
	f := strings.Fields(strings.SplitN(string(b), "\n", 2)[0])
	for i, v := range f[1:] {
		if i >= 8 {
			break
		}
		n, _ := strconv.ParseUint(v, 10, 64)
		total += n
		switch i {
		case 3, 4: // idle + iowait
			idle += n
		case 7:
			steal = n
		}
	}
	return
}

func readMem() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	var total, avail float64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		if len(fs) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(fs[1], 64)
		switch fs[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total == 0 {
		return 0
	}
	return (total - avail) / total * 100
}

// 虚拟网卡：流量在物理网卡上已经算过一次（WireGuard、隧道、容器网桥等），再加就重复了
var virtIfPrefixes = []string{"lo", "docker", "veth", "br-", "virbr", "vnet", "tun", "tap", "warp", "wg", "ifb", "tailscale", "zt", "cni", "flannel", "cali", "kube", "sit", "ip6tnl", "gre", "erspan", "ipip", "dummy", "nodedeck", "sb-", "singbox"}

// netIfaces 要统计的网卡：有物理设备（/sys/class/net/X/device）的那些；一个都没有时（OpenVZ 的 venet0 等）按名字排除虚拟网卡
func netIfaces(names []string) map[string]bool {
	out := map[string]bool{}
	for _, n := range names {
		if _, err := os.Stat("/sys/class/net/" + n + "/device"); err == nil {
			out[n] = true
		}
	}
	if len(out) > 0 {
		return out
	}
	for _, n := range names {
		virt := false
		for _, p := range virtIfPrefixes {
			if strings.HasPrefix(n, p) {
				virt = true
				break
			}
		}
		if !virt {
			out[n] = true
		}
	}
	return out
}

func readNet() (rx, tx uint64) {
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return
	}
	lines := strings.Split(string(b), "\n")
	if len(lines) < 3 {
		return
	}
	var names []string
	for _, line := range lines[2:] {
		if i := strings.Index(line, ":"); i > 0 {
			names = append(names, strings.TrimSpace(line[:i]))
		}
	}
	use := netIfaces(names)
	for _, line := range lines[2:] {
		i := strings.Index(line, ":")
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		if !use[name] {
			continue
		}
		f := strings.Fields(line[i+1:])
		if len(f) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(f[0], 10, 64)
		t, _ := strconv.ParseUint(f[8], 10, 64)
		rx += r
		tx += t
	}
	return
}

func readLoad() float64 {
	b, _ := os.ReadFile("/proc/loadavg")
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

func diskUsage() (used, total uint64) {
	var st syscall.Statfs_t
	if syscall.Statfs("/", &st) != nil {
		return
	}
	total = st.Blocks * uint64(st.Bsize)
	used = total - st.Bavail*uint64(st.Bsize)
	return
}

var pingAvg = regexp.MustCompile(`= *[\d.]+/([\d.]+)/`)

// ping 3 次取平均延迟（毫秒）；系统没有 ping 时改用 TCP 53 端口握手时间；都失败返回 -1
func pingMs(host string) float64 {
	if _, err := exec.LookPath("ping"); err == nil {
		out, _ := exec.Command("ping", "-c", "3", "-W", "2", "-q", host).CombinedOutput()
		if m := pingAvg.FindSubmatch(out); m != nil {
			v, _ := strconv.ParseFloat(string(m[1]), 64)
			return v
		}
		return -1
	}
	best := -1.0
	for i := 0; i < 3; i++ {
		t0 := time.Now()
		c, err := net.DialTimeout("tcp", net.JoinHostPort(host, "53"), 2*time.Second)
		if err != nil {
			continue
		}
		c.Close()
		if ms := float64(time.Since(t0).Microseconds()) / 1000; best < 0 || ms < best {
			best = ms
		}
	}
	return best
}

func (a *Agent) latTargets() map[string]string {
	if len(a.cfg.LatencyTargets) > 0 {
		return a.cfg.LatencyTargets
	}
	return defaultLatTargets
}

func (a *Agent) loadMetrics() {
	m := &Metrics{}
	_ = readJSON(a.path("metrics.json"), m)
	a.metrics = m
}

func (a *Agent) saveMetrics() {
	m := a.metrics
	m.mu.Lock()
	b, _ := json.Marshal(m)
	m.mu.Unlock()
	if err := writeFileAtomic(a.path("metrics.json"), b, 0600); err != nil {
		log.Printf("保存监控数据失败: %v", err)
	}
}

func avgSamples(list []Sample, t int64) Sample {
	s := Sample{T: t, Lat: map[string]float64{}, Loss: map[string]float64{}, Jit: map[string]float64{}}
	if len(list) == 0 {
		return s
	}
	latN := map[string]int{}
	lossN := map[string]int{}
	jitN := map[string]int{}
	conn := 0
	for _, x := range list {
		s.CPU += x.CPU
		s.Mem += x.Mem
		s.Rx += x.Rx
		s.Tx += x.Tx
		s.Load += x.Load
		for k, v := range x.Lat {
			if v >= 0 {
				s.Lat[k] += v
				latN[k]++
			}
		}
		for k, v := range x.Loss {
			s.Loss[k] += v
			lossN[k]++
		}
		for k, v := range x.Jit {
			s.Jit[k] += v
			jitN[k]++
		}
		s.Retr += x.Retr
		s.Steal += x.Steal
		s.PUp += x.PUp
		s.PDown += x.PDown
		conn += x.Conn
	}
	n := float64(len(list))
	s.CPU /= n
	s.Mem /= n
	s.Rx /= n
	s.Tx /= n
	s.Load /= n
	for k, c := range latN {
		s.Lat[k] /= float64(c)
	}
	for k, c := range lossN {
		s.Loss[k] /= float64(c)
	}
	for k, c := range jitN {
		s.Jit[k] /= float64(c)
	}
	s.Retr /= n
	s.Steal /= n
	s.PUp /= n
	s.PDown /= n
	s.Conn = conn / len(list)
	return s
}

// collect 每分钟调用一次
func (a *Agent) collect(withLatency bool) {
	m := a.metrics
	now := time.Now()
	idle, total, steal := readCPUSteal()
	rx, tx := readNet()
	var pUp, pDown int64
	a.mu.Lock()
	for _, t := range a.traffic {
		pUp += t.Up
		pDown += t.Down
	}
	a.mu.Unlock()
	var lat, loss, jit map[string]float64
	if withLatency {
		lat, loss, jit = map[string]float64{}, map[string]float64{}, map[string]float64{}
		var wg sync.WaitGroup
		var lmu sync.Mutex
		for name, host := range a.latTargets() {
			wg.Add(1)
			go func(name, host string) {
				defer wg.Done()
				// 每个目标连发 10 个 ping（间隔 0.3 秒），同时得到延迟、丢包、抖动
				r := icmpPing(host, 10, 300*time.Millisecond, 2*time.Second)
				lmu.Lock()
				defer lmu.Unlock()
				if r.Error != "" { // 没有原始套接字权限（个别容器）：退回老办法，只测延迟
					lat[name] = pingMs(host)
					return
				}
				if r.Recv > 0 {
					lat[name] = r.Avg
				} else {
					lat[name] = -1
				}
				loss[name] = r.Loss
				jit[name] = r.Jitter
			}(name, host)
		}
		wg.Wait()
	}
	snmp := readSNMP()
	out, retr := snmp["Tcp.OutSegs"], tcpDataRetrans(snmp, readNetstat())
	conn := readTCPStats().InUse
	m.mu.Lock()
	defer m.mu.Unlock()
	if lat != nil {
		m.lastLat, m.lastLoss, m.lastJit = lat, loss, jit
	}
	month := now.In(a.loc()).Format("2006-01")
	if m.Month.Month != month {
		var since int64
		if m.Month.Month == "" { // 第一次统计：从今天开始，不是整月
			since = now.Unix()
		}
		m.Month = MonthTraffic{Month: month, LastRx: rx, LastTx: tx, Since: since}
	} else {
		// 计数器变小说明重启过，从 0 重新累计
		if rx >= m.Month.LastRx {
			m.Month.Rx += int64(rx - m.Month.LastRx)
		} else {
			m.Month.Rx += int64(rx)
		}
		if tx >= m.Month.LastTx {
			m.Month.Tx += int64(tx - m.Month.LastTx)
		} else {
			m.Month.Tx += int64(tx)
		}
		m.Month.LastRx, m.Month.LastTx = rx, tx
	}
	if !m.lastT.IsZero() {
		secs := now.Sub(m.lastT).Seconds()
		s := Sample{T: now.Unix(), Mem: readMem(), Load: readLoad(), Lat: m.lastLat, Loss: m.lastLoss, Jit: m.lastJit, Conn: conn}
		if dOut := out - m.lastSNMP[0]; out >= m.lastSNMP[0] && retr >= m.lastSNMP[1] && dOut > 0 && m.lastSNMP[0] > 0 {
			s.Retr = 100 * float64(retr-m.lastSNMP[1]) / float64(dOut)
		}
		if dt := total - m.lastCPU[1]; dt > 0 && total >= m.lastCPU[1] {
			s.CPU = 100 * (1 - float64(idle-m.lastCPU[0])/float64(dt))
			if steal >= m.lastSteal {
				s.Steal = 100 * float64(steal-m.lastSteal) / float64(dt)
			}
		}
		// 代理流量：用户流量计数的增量（周期重置时计数会变小，这一分钟记 0）
		if m.lastProxy[0] > 0 || m.lastProxy[1] > 0 {
			if d := pUp - m.lastProxy[0]; d > 0 && secs > 0 {
				s.PUp = float64(d) / secs
			}
			if d := pDown - m.lastProxy[1]; d > 0 && secs > 0 {
				s.PDown = float64(d) / secs
			}
		}
		if rx >= m.lastNet[0] && tx >= m.lastNet[1] && secs > 0 {
			s.Rx = float64(rx-m.lastNet[0]) / secs
			s.Tx = float64(tx-m.lastNet[1]) / secs
		}
		m.Minutes = append(m.Minutes, s)
		if len(m.Minutes) > 1440 {
			m.Minutes = m.Minutes[len(m.Minutes)-1440:]
		}
		hour := now.Unix() / 3600 * 3600
		if m.hourMark != 0 && hour != m.hourMark && len(m.hourBuf) > 0 {
			m.Hours = append(m.Hours, avgSamples(m.hourBuf, m.hourMark))
			if len(m.Hours) > 720 {
				m.Hours = m.Hours[len(m.Hours)-720:]
			}
			m.hourBuf = nil
		}
		m.hourMark = hour
		m.hourBuf = append(m.hourBuf, s)
	}
	m.lastSNMP = [2]uint64{out, retr}
	m.lastCPU = [2]uint64{idle, total}
	m.lastSteal = steal
	m.lastProxy = [2]int64{pUp, pDown}
	m.lastNet = [2]uint64{rx, tx}
	m.lastT = now
}

type metricsResp struct {
	Now       *Sample      `json:"now"`
	Live      *Sample      `json:"live,omitempty"` // 刚才 1 秒内的 CPU / 网速（打开监控时现测）
	Series    []Sample     `json:"series"`
	Month     MonthTraffic `json:"month"`
	DiskUsed  uint64       `json:"diskUsed"`
	DiskTotal uint64       `json:"diskTotal"`
	Uptime    int64        `json:"uptime"`
	Cores     int          `json:"cores"`
}

func (a *Agent) metricsFor(rng string) metricsResp {
	m := a.metrics
	m.mu.Lock()
	defer m.mu.Unlock()
	r := metricsResp{Month: m.Month}
	r.DiskUsed, r.DiskTotal = diskUsage()
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		f := strings.Fields(string(b))
		if len(f) > 0 {
			v, _ := strconv.ParseFloat(f[0], 64)
			r.Uptime = int64(v)
		}
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		r.Cores = strings.Count(string(b), "processor\t:")
	}
	if n := len(m.Minutes); n > 0 {
		last := m.Minutes[n-1]
		r.Now = &last
	}
	now := time.Now().Unix()
	switch rng {
	case "1h":
		r.Series = since(m.Minutes, now-3600)
	case "7d", "30d":
		days := int64(7)
		if rng == "30d" {
			days = 30
		}
		r.Series = since(m.Hours, now-days*86400)
		if len(m.hourBuf) > 0 {
			r.Series = append(r.Series, currentHour(m))
		}
	default: // 24h：分钟数据每 10 分钟取一个平均点
		src := since(m.Minutes, now-86400)
		for i := 0; i < len(src); i += 10 {
			j := i + 10
			if j > len(src) {
				j = len(src)
			}
			r.Series = append(r.Series, avgSamples(src[i:j], src[j-1].T))
		}
	}
	return r
}

func since(list []Sample, t int64) []Sample {
	for i, s := range list {
		if s.T >= t {
			return append([]Sample(nil), list[i:]...)
		}
	}
	return nil
}

func currentHour(m *Metrics) Sample { return avgSamples(m.hourBuf, m.hourMark) }

func (a *Agent) metricsLoop() {
	a.collect(false)
	if !a.cfg.LatencyProbe {
		a.metrics.mu.Lock()
		a.metrics.lastLat, a.metrics.lastLoss, a.metrics.lastJit = nil, nil, nil // 关掉后不再沿用旧数据
		a.metrics.mu.Unlock()
	}
	tick := time.NewTicker(time.Minute)
	n := 0
	for range tick.C {
		a.collect(a.cfg.LatencyProbe && n%5 == 0) // 打开了后台测速才每 5 分钟测一次三网延迟
		n++
		if n%10 == 0 {
			a.saveMetrics()
		}
		a.checkVPSExpire()
		a.checkAlerts(time.Now())
		if time.Now().Minute() == 7 { // 每小时整理一次日志
			trimLogs()
		}
	}
}

// VPS 快到期提醒（提前 7 天和 1 天）
func (a *Agent) checkVPSExpire() {
	exp := a.cfg.VPSExpireAt
	if exp <= 0 {
		return
	}
	left := exp - time.Now().Unix()
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, d := range []int64{7, 1} {
		if left > 0 && left <= d*86400 {
			a.notifyOnce(fmt.Sprintf("vps-exp:%d:%d", exp, d), fmt.Sprintf("🖥 这台 VPS 将在 %s 到期（还剩 %.1f 天），记得续费", time.Unix(exp, 0).In(a.loc()).Format("2006-01-02"), float64(left)/86400))
			break
		}
	}
}

// liveNow 现测 1 秒：CPU、steal、网卡收发速率（打开监控面板时用，表头显示的是这个）
func liveNow() *Sample {
	i0, t0, s0 := readCPUSteal()
	r0, x0 := readNet()
	start := time.Now()
	time.Sleep(time.Second)
	i1, t1, s1 := readCPUSteal()
	r1, x1 := readNet()
	secs := time.Since(start).Seconds()
	out := &Sample{T: time.Now().Unix(), Mem: readMem(), Load: readLoad()}
	if dt := float64(t1 - t0); t1 > t0 {
		out.CPU = 100 * (1 - float64(i1-i0)/dt)
		if s1 >= s0 {
			out.Steal = 100 * float64(s1-s0) / dt
		}
	}
	if r1 >= r0 && x1 >= x0 {
		out.Rx = float64(r1-r0) / secs
		out.Tx = float64(x1-x0) / secs
	}
	return out
}
