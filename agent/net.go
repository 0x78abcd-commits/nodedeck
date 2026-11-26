package main

// 网络优化：检测内核 / 拥塞控制 / 队列 / 网卡 / 缓冲区，按机器情况给出少量有依据的调整，
// 应用前备份原值，可一键恢复。只改下面 tuneKeys 里的几项，不做「几十项一起改」的那种优化。
import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// 我们可能会改的 sysctl（只有这些）
var tuneKeys = []string{
	"net.ipv4.tcp_congestion_control",
	"net.core.default_qdisc",
	"net.ipv4.tcp_rmem",
	"net.ipv4.tcp_wmem",
	"net.core.rmem_max",
	"net.core.wmem_max",
	"net.ipv4.tcp_mtu_probing",
	"net.ipv4.tcp_window_scaling",
}

// 只读展示的
var infoKeys = []string{"net.ipv4.tcp_available_congestion_control", "net.ipv4.tcp_moderate_rcvbuf", "net.core.rmem_default", "net.core.wmem_default", "net.ipv4.tcp_slow_start_after_idle"}

const tuneConf = "/etc/sysctl.d/99-nodedeck-net.conf"
const bbrModConf = "/etc/modules-load.d/nodedeck-bbr.conf"

func sysctlPath(k string) string { return "/proc/sys/" + strings.ReplaceAll(k, ".", "/") }

func sysctlGet(k string) string {
	b, err := os.ReadFile(sysctlPath(k))
	if err != nil {
		return ""
	}
	return strings.Join(strings.Fields(string(b)), " ")
}

func sysctlSet(k, v string) error {
	return os.WriteFile(sysctlPath(k), []byte(v+"\n"), 0644)
}

type NetIface struct {
	Name     string `json:"name"`
	Driver   string `json:"driver"`
	MTU      int    `json:"mtu"`
	Speed    string `json:"speed"`
	RxQueues int    `json:"rxQueues"`
	TxQueues int    `json:"txQueues"`
	Qdisc    string `json:"qdisc"`
}

type TuneItem struct {
	Key   string `json:"key"`
	Name  string `json:"name"`  // 给人看的名字
	Cur   string `json:"cur"`   // 现在的值
	Want  string `json:"want"`  // 建议的值
	Why   string `json:"why"`   // 为什么（大白话）
	Apply bool   `json:"apply"` // 需要改
}

type NetInfo struct {
	Kernel      string            `json:"kernel"`
	KernelMajor int               `json:"kernelMajor"`
	KernelMinor int               `json:"kernelMinor"`
	CC          string            `json:"cc"`
	CCAvail     []string          `json:"ccAvail"`
	BBRSupport  bool              `json:"bbrSupport"`
	BBRNote     string            `json:"bbrNote"`
	Qdisc       string            `json:"qdisc"`
	Iface       NetIface          `json:"iface"`
	IPv4        bool              `json:"ipv4"`
	IPv6        bool              `json:"ipv6"`
	MemMB       int               `json:"memMB"`
	Sysctl      map[string]string `json:"sysctl"`
	TCP         TCPStats          `json:"tcp"`
	Tuned       bool              `json:"tuned"`  // 已应用过 NodeDeck 的调整
	Backup      bool              `json:"backup"` // 有原始值备份，可以恢复
	Items       []TuneItem        `json:"items"`  // 建议
	Virt        string            `json:"virt"`
	Container   bool              `json:"container"` // OpenVZ / LXC 等容器改不了内核参数
}

type TCPStats struct {
	OutSegs     uint64  `json:"outSegs"`
	RetransSegs uint64  `json:"retransSegs"`
	RetransPct  float64 `json:"retransPct"` // 开机以来，不含 SYN 重传
	SynRetrans  uint64  `json:"synRetrans"`
	// 最近 1 小时的平均重传率（读 agent 每分钟记的数据）；-1 = 没有数据
	RetransPct1h float64 `json:"retransPct1h"`
	Retrans1hN   int     `json:"retrans1hN"` // 用了几分钟的数据
	Established  int     `json:"established"`
	TimeWait     int     `json:"timeWait"`
	InUse        int     `json:"inUse"`
	ActiveOpens  uint64  `json:"activeOpens"`
	AttemptFails uint64  `json:"attemptFails"`
}

func readSNMP() map[string]uint64 { return readProcPairs("/proc/net/snmp") }

// readNetstat /proc/net/netstat（TcpExt 等扩展计数，格式和 snmp 一样）
func readNetstat() map[string]uint64 { return readProcPairs("/proc/net/netstat") }

// tcpDataRetrans 数据段重传（去掉 SYN 重传）：连不上的目标会反复重发 SYN，那是对方的问题，不代表线路丢包
func tcpDataRetrans(snmp, nst map[string]uint64) uint64 {
	r, syn := snmp["Tcp.RetransSegs"], nst["TcpExt.TCPSynRetrans"]
	if syn > r {
		return 0
	}
	return r - syn
}

func readProcPairs(path string) map[string]uint64 {
	out := map[string]uint64{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	lines := strings.Split(string(b), "\n")
	for i := 0; i+1 < len(lines); i++ {
		h := strings.Fields(lines[i])
		v := strings.Fields(lines[i+1])
		if len(h) < 2 || len(h) != len(v) || h[0] != v[0] {
			continue
		}
		for j := 1; j < len(h); j++ {
			n, _ := strconv.ParseUint(v[j], 10, 64)
			out[strings.TrimSuffix(h[0], ":")+"."+h[j]] = n
		}
		i++
	}
	return out
}

func readTCPStats() TCPStats {
	s := readSNMP()
	nst := readNetstat()
	t := TCPStats{OutSegs: s["Tcp.OutSegs"], RetransSegs: tcpDataRetrans(s, nst), SynRetrans: nst["TcpExt.TCPSynRetrans"], ActiveOpens: s["Tcp.ActiveOpens"], AttemptFails: s["Tcp.AttemptFails"], Established: int(s["Tcp.CurrEstab"]), RetransPct1h: -1}
	if t.OutSegs > 0 {
		t.RetransPct = 100 * float64(t.RetransSegs) / float64(t.OutSegs)
	}
	if b, err := os.ReadFile("/proc/net/sockstat"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			f := strings.Fields(l)
			if len(f) > 0 && f[0] == "TCP:" {
				for i := 1; i+1 < len(f); i += 2 {
					n, _ := strconv.Atoi(f[i+1])
					switch f[i] {
					case "inuse":
						t.InUse = n
					case "tw":
						t.TimeWait = n
					}
				}
			}
		}
	}
	return t
}

func defaultIface() string {
	b, _ := os.ReadFile("/proc/net/route")
	for _, l := range strings.Split(string(b), "\n")[1:] {
		f := strings.Fields(l)
		if len(f) > 2 && f[1] == "00000000" {
			return f[0]
		}
	}
	return ""
}

func hasIPv6Route() bool {
	b, _ := os.ReadFile("/proc/net/ipv6_route")
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		// 默认路由：目的 ::/0，且不是 lo
		if len(f) >= 10 && f[0] == strings.Repeat("0", 32) && f[1] == "00" && f[9] != "lo" {
			return true
		}
	}
	return false
}

func readIface(name string) NetIface {
	i := NetIface{Name: name}
	if name == "" {
		return i
	}
	base := "/sys/class/net/" + name
	if l, err := os.Readlink(base + "/device/driver"); err == nil {
		i.Driver = filepath.Base(l)
	} else {
		i.Driver = "虚拟网卡"
	}
	if b, err := os.ReadFile(base + "/mtu"); err == nil {
		i.MTU, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	if b, err := os.ReadFile(base + "/speed"); err == nil {
		if v := strings.TrimSpace(string(b)); v != "" && v != "-1" {
			i.Speed = v + " Mb/s"
		}
	}
	if ents, err := os.ReadDir(base + "/queues"); err == nil {
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), "rx-") {
				i.RxQueues++
			} else if strings.HasPrefix(e.Name(), "tx-") {
				i.TxQueues++
			}
		}
	}
	if _, err := exec.LookPath("tc"); err == nil {
		if out, err := exec.Command("tc", "qdisc", "show", "dev", name, "root").Output(); err == nil {
			if f := strings.Fields(string(out)); len(f) > 1 {
				i.Qdisc = f[1]
			}
		}
	}
	return i
}

func kernelVersion() (string, int, int) {
	var u syscall.Utsname
	if syscall.Uname(&u) != nil {
		return "", 0, 0
	}
	var b []byte
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	rel := string(b)
	var maj, min int
	fmt.Sscanf(rel, "%d.%d", &maj, &min)
	return rel, maj, min
}

func bbrModuleExists(rel string) bool {
	m, _ := filepath.Glob("/lib/modules/" + rel + "/kernel/net/ipv4/tcp_bbr.ko*")
	return len(m) > 0
}

func memTotalMB() int {
	b, _ := os.ReadFile("/proc/meminfo")
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "MemTotal:") {
			f := strings.Fields(l)
			if len(f) > 1 {
				kb, _ := strconv.Atoi(f[1])
				return kb / 1024
			}
		}
	}
	return 0
}

func detectVirt() (string, bool) {
	if _, err := os.Stat("/proc/user_beancounters"); err == nil {
		return "openvz", true
	}
	if b, err := os.ReadFile("/proc/1/environ"); err == nil && strings.Contains(string(b), "container=") {
		return "container", true
	}
	if out, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		v := strings.TrimSpace(string(out))
		return v, v == "lxc" || v == "lxc-libvirt" || v == "openvz" || v == "docker" || v == "podman"
	}
	return "", false
}

// 缓冲区上限：按内存给，长距离（国内到海外 150~250ms）单连接要跑满带宽需要的窗口 ≈ 带宽 × 延迟，
// 1Gbps × 200ms ≈ 25MB。小内存机器给小一点（这只是上限，内核按需分配）
func bufMaxFor(memMB int) int {
	switch {
	case memMB > 0 && memMB <= 1100:
		return 16 << 20
	case memMB > 0 && memMB <= 4200:
		return 32 << 20
	default:
		return 64 << 20
	}
}

func lastField(v string) int {
	f := strings.Fields(v)
	if len(f) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(f[len(f)-1])
	return n
}

func fmtMB(n int) string { return fmt.Sprintf("%dMB", n>>20) }

func collectNetInfo(dataDir string) NetInfo {
	rel, maj, min := kernelVersion()
	ni := NetInfo{Kernel: rel, KernelMajor: maj, KernelMinor: min, Sysctl: map[string]string{}}
	for _, k := range append(append([]string{}, tuneKeys...), infoKeys...) {
		ni.Sysctl[k] = sysctlGet(k)
	}
	ni.CC = ni.Sysctl["net.ipv4.tcp_congestion_control"]
	ni.CCAvail = strings.Fields(ni.Sysctl["net.ipv4.tcp_available_congestion_control"])
	ni.Qdisc = ni.Sysctl["net.core.default_qdisc"]
	kernelOK := maj > 4 || (maj == 4 && min >= 9)
	inAvail := false
	for _, c := range ni.CCAvail {
		if c == "bbr" {
			inAvail = true
		}
	}
	ni.BBRSupport = kernelOK && (inAvail || bbrModuleExists(rel))
	switch {
	case !kernelOK:
		ni.BBRNote = fmt.Sprintf("内核 %d.%d 太旧（BBR 需要 4.9 以上），需要先升级系统内核", maj, min)
	case !ni.BBRSupport:
		ni.BBRNote = "这个内核没有编译 BBR 模块"
	case ni.CC == "bbr":
		ni.BBRNote = "已启用"
	default:
		ni.BBRNote = "支持，未启用"
	}
	ni.Iface = readIface(defaultIface())
	ni.IPv4 = ni.Iface.Name != ""
	ni.IPv6 = hasIPv6Route()
	ni.MemMB = memTotalMB()
	ni.TCP = readTCPStats()
	ni.TCP.RetransPct1h, ni.TCP.Retrans1hN = recentRetrans(dataDir, time.Now().Unix()-3600)
	ni.Virt, ni.Container = detectVirt()
	_, err1 := os.Stat(tuneConf)
	ni.Tuned = err1 == nil
	_, err2 := os.Stat(filepath.Join(dataDir, "net-backup.json"))
	ni.Backup = err2 == nil
	ni.Items = recommend(ni)
	return ni
}

// recommend 按机器情况给出建议；Apply=false 表示现状已经合适
func recommend(ni NetInfo) []TuneItem {
	var items []TuneItem
	add := func(key, name, want, why string) {
		cur := ni.Sysctl[key]
		items = append(items, TuneItem{Key: key, Name: name, Cur: cur, Want: want, Why: why, Apply: cur != want})
	}
	if ni.BBRSupport {
		add("net.ipv4.tcp_congestion_control", "TCP 拥塞控制", "bbr",
			"BBR 按测到的带宽和延迟发数据，不会因为偶尔丢包就大幅降速。国内到海外这种长距离、有丢包的线路上通常明显比默认的 CUBIC 快。只影响 TCP（Reality、Trojan、VMess、AnyTLS 等），不影响 Hysteria2 / TUIC")
		add("net.core.default_qdisc", "发包队列", "fq",
			"fq 让每个连接均匀、平稳地发包，是 BBR 推荐搭配的队列")
	}
	bm := bufMaxFor(ni.MemMB)
	if lastField(ni.Sysctl["net.ipv4.tcp_rmem"]) < bm || lastField(ni.Sysctl["net.ipv4.tcp_wmem"]) < bm {
		rmem := strings.Fields(ni.Sysctl["net.ipv4.tcp_rmem"])
		wmem := strings.Fields(ni.Sysctl["net.ipv4.tcp_wmem"])
		r1, r2, w1, w2 := "4096", "131072", "4096", "16384"
		if len(rmem) == 3 {
			r1, r2 = rmem[0], rmem[1]
		}
		if len(wmem) == 3 {
			w1, w2 = wmem[0], wmem[1]
		}
		why := fmt.Sprintf("单个连接最多能「在路上」的数据量。距离远（延迟高）时上限太小会卡住单线程速度。按这台 %dMB 内存给到 %s，只是上限，用多少分配多少", ni.MemMB, fmtMB(bm))
		add("net.ipv4.tcp_rmem", "TCP 接收缓冲区", fmt.Sprintf("%s %s %d", r1, r2, bm), why)
		add("net.ipv4.tcp_wmem", "TCP 发送缓冲区", fmt.Sprintf("%s %s %d", w1, w2, bm), why)
	} else {
		items = append(items, TuneItem{Key: "net.ipv4.tcp_rmem", Name: "TCP 缓冲区", Cur: ni.Sysctl["net.ipv4.tcp_rmem"], Want: ni.Sysctl["net.ipv4.tcp_rmem"], Why: "已经够大，不用改"})
	}
	// UDP / QUIC：Hysteria2、TUIC 用的 QUIC 库会尝试把 UDP 缓冲区调到约 7MB，系统上限太小会报警告、速度上不去
	ub := 16 << 20
	if bm > ub {
		ub = bm
	}
	if n, _ := strconv.Atoi(ni.Sysctl["net.core.rmem_max"]); n < ub {
		add("net.core.rmem_max", "接收缓冲区上限（含 UDP）", strconv.Itoa(ub), "Hysteria2 / TUIC 走 UDP（QUIC），需要较大的 UDP 接收缓冲区，否则高速时会丢包、跑不满。这项对 QUIC 是真正有用的，BBR 对 QUIC 没作用")
	}
	if n, _ := strconv.Atoi(ni.Sysctl["net.core.wmem_max"]); n < ub {
		add("net.core.wmem_max", "发送缓冲区上限（含 UDP）", strconv.Itoa(ub), "同上，给 QUIC 发送用")
	}
	add("net.ipv4.tcp_mtu_probing", "路径 MTU 探测", "1",
		"有的线路中间会悄悄丢掉大包，导致连接卡住。打开后遇到这种情况会自动改发小包，平时不影响")
	if ni.Sysctl["net.ipv4.tcp_window_scaling"] != "1" {
		add("net.ipv4.tcp_window_scaling", "TCP 窗口自动扩大", "1", "关掉时单连接速度会被限制在很低，必须打开")
	}
	return items
}

type netBackup struct {
	Sysctl     map[string]string `json:"sysctl"`
	IfaceQdisc string            `json:"ifaceQdisc"`
	Iface      string            `json:"iface"`
}

// applyTune 应用建议（keys 为空表示全部建议项），第一次应用前备份原值
func applyTune(dataDir string, keys []string) (NetInfo, []string, error) {
	ni := collectNetInfo(dataDir)
	// 容器（OpenVZ / LXC）里大部分内核参数由宿主机决定，能改的改，改不了的跳过并说明
	want := map[string]bool{}
	for _, k := range keys {
		want[k] = true
	}
	bpath := filepath.Join(dataDir, "net-backup.json")
	if _, err := os.Stat(bpath); err != nil {
		bk := netBackup{Sysctl: map[string]string{}, IfaceQdisc: ni.Iface.Qdisc, Iface: ni.Iface.Name}
		for _, k := range tuneKeys {
			bk.Sysctl[k] = ni.Sysctl[k]
		}
		b, _ := json.MarshalIndent(bk, "", "  ")
		if err := writeFileAtomic(bpath, b, 0600); err != nil {
			return ni, nil, err
		}
	}
	// 以前版本直接写进 /etc/sysctl.conf 的 BBR 两行，统一挪到我们自己的文件里
	removeOldBBRLines()
	var done, failed []string
	conf := map[string]string{}
	// 保留之前已写入的项
	if b, err := os.ReadFile(tuneConf); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if i := strings.Index(l, "="); i > 0 && !strings.HasPrefix(strings.TrimSpace(l), "#") {
				conf[strings.TrimSpace(l[:i])] = strings.TrimSpace(l[i+1:])
			}
		}
	}
	for _, it := range ni.Items {
		if len(want) > 0 && !want[it.Key] {
			continue
		}
		if !it.Apply {
			// 现在已经是想要的值（可能是运行中临时改的）：也写进配置，保证重启后还是这样
			if it.Want != "" && it.Want == sysctlGet(it.Key) {
				conf[it.Key] = it.Want
			}
			continue
		}
		if it.Key == "net.ipv4.tcp_congestion_control" && it.Want == "bbr" {
			loadBBR()
		}
		if err := sysctlSet(it.Key, it.Want); err != nil {
			why := err.Error()
			if ni.Container {
				why = "容器里改不了，由宿主机决定"
			}
			failed = append(failed, fmt.Sprintf("%s：%s", it.Name, why))
			continue
		}
		conf[it.Key] = it.Want
		done = append(done, fmt.Sprintf("%s：%s → %s", it.Name, it.Cur, it.Want))
		if it.Key == "net.core.default_qdisc" {
			// default_qdisc 只对之后新建的队列生效；单队列网卡顺便把当前网卡也换成 fq
			if ni.Iface.Name != "" && ni.Iface.TxQueues <= 1 {
				if _, err := exec.LookPath("tc"); err == nil {
					_ = exec.Command("tc", "qdisc", "replace", "dev", ni.Iface.Name, "root", it.Want).Run()
				}
			}
		}
	}
	if err := writeTuneConf(conf); err != nil {
		return ni, done, err
	}
	disableConflicts(sysctlConf, conf)
	var ferr error
	if len(failed) > 0 {
		ferr = fmt.Errorf("有 %d 项没改成：%s", len(failed), strings.Join(failed, "；"))
	}
	return collectNetInfo(dataDir), done, ferr
}

func writeTuneConf(conf map[string]string) error {
	if len(conf) == 0 {
		os.Remove(tuneConf)
		return nil
	}
	keys := make([]string, 0, len(conf))
	for k := range conf {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	sb.WriteString("# NodeDeck 网络优化（在 NodeDeck 里点「恢复原始设置」会删除这个文件并还原）\n")
	for _, k := range keys {
		sb.WriteString(k + " = " + conf[k] + "\n")
	}
	_ = os.MkdirAll(filepath.Dir(tuneConf), 0755)
	return os.WriteFile(tuneConf, []byte(sb.String()), 0644)
}

const sysctlConf = "/etc/sysctl.conf"
const offMark = "# nodedeck-off: "

// disableConflicts 把 /etc/sysctl.conf 里和我们设置冲突的行注释掉。
// 开机时 /etc/sysctl.conf 比 sysctl.d 里的文件后生效，不注释的话重启后会被它改回去（常见于以前跑过别的 BBR 脚本）。
// 恢复原始设置时会去掉注释。
func disableConflicts(path string, conf map[string]string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	lines := strings.Split(string(b), "\n")
	changed := false
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, ";") {
			continue
		}
		eq := strings.Index(t, "=")
		if eq <= 0 {
			continue
		}
		k := strings.ReplaceAll(strings.TrimSpace(strings.TrimPrefix(t[:eq], "-")), "/", ".")
		v := strings.Join(strings.Fields(t[eq+1:]), " ")
		if want, ok := conf[k]; ok && v != want {
			lines[i] = offMark + l
			changed = true
		}
	}
	if changed {
		_ = os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644)
	}
}

func enableConflicts(path string) {
	b, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(b), offMark) {
		return
	}
	lines := strings.Split(string(b), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimPrefix(l, offMark)
	}
	_ = os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0644)
}

func loadBBR() {
	if strings.Contains(sysctlGet("net.ipv4.tcp_available_congestion_control"), "bbr") {
		return
	}
	if _, err := exec.LookPath("modprobe"); err == nil {
		_ = exec.Command("modprobe", "tcp_bbr").Run()
	}
	_ = os.MkdirAll(filepath.Dir(bbrModConf), 0755)
	_ = os.WriteFile(bbrModConf, []byte("tcp_bbr\n"), 0644)
}

func removeOldBBRLines() {
	b, err := os.ReadFile("/etc/sysctl.conf")
	if err != nil || !strings.Contains(string(b), "nodedeck-bbr") {
		return
	}
	var out []string
	skip := 0
	for _, l := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(l) == "# nodedeck-bbr" {
			skip = 2
			continue
		}
		if skip > 0 && (strings.HasPrefix(l, "net.core.default_qdisc") || strings.HasPrefix(l, "net.ipv4.tcp_congestion_control")) {
			skip--
			continue
		}
		out = append(out, l)
	}
	_ = os.WriteFile("/etc/sysctl.conf", []byte(strings.Join(out, "\n")), 0644)
}

// restoreTune 恢复第一次调整前的原值，删掉我们的配置文件
func restoreTune(dataDir string) ([]string, error) {
	bpath := filepath.Join(dataDir, "net-backup.json")
	var bk netBackup
	if err := readJSON(bpath, &bk); err != nil {
		return nil, fmt.Errorf("没有找到原始设置的备份，可能从来没有改过")
	}
	var done []string
	for _, k := range tuneKeys {
		v, ok := bk.Sysctl[k]
		if !ok || v == "" {
			continue
		}
		if cur := sysctlGet(k); cur != v {
			if err := sysctlSet(k, v); err == nil {
				done = append(done, fmt.Sprintf("%s：%s → %s", keyName(k), cur, v))
			}
		}
	}
	if bk.Iface != "" && bk.IfaceQdisc != "" {
		if _, err := exec.LookPath("tc"); err == nil {
			if cur := readIface(bk.Iface).Qdisc; cur != bk.IfaceQdisc {
				_ = exec.Command("tc", "qdisc", "del", "dev", bk.Iface, "root").Run() // 删掉后内核恢复默认队列
			}
		}
	}
	os.Remove(tuneConf)
	os.Remove(bbrModConf)
	os.Remove(bpath)
	removeOldBBRLines()
	enableConflicts(sysctlConf)
	return done, nil
}

// setCC 临时切换拥塞控制（对比测试用，不写配置文件，重启后失效）
func setCC(cc string) error {
	if cc == "bbr" {
		loadBBR()
	}
	return sysctlSet("net.ipv4.tcp_congestion_control", cc)
}

func keyName(k string) string {
	return map[string]string{
		"net.ipv4.tcp_congestion_control": "TCP 拥塞控制", "net.core.default_qdisc": "发包队列",
		"net.ipv4.tcp_rmem": "TCP 接收缓冲区", "net.ipv4.tcp_wmem": "TCP 发送缓冲区",
		"net.core.rmem_max": "接收缓冲区上限（含 UDP）", "net.core.wmem_max": "发送缓冲区上限（含 UDP）",
		"net.ipv4.tcp_mtu_probing": "路径 MTU 探测", "net.ipv4.tcp_window_scaling": "TCP 窗口自动扩大",
	}[k]
}

// recentRetrans 从 agent 保存的分钟数据里算最近一段时间的平均重传率（只算有发包的分钟）
func recentRetrans(dataDir string, since int64) (float64, int) {
	var m Metrics
	if dataDir == "" || readJSON(filepath.Join(dataDir, "metrics.json"), &m) != nil {
		return -1, 0
	}
	sum, n := 0.0, 0
	for _, x := range m.Minutes {
		if x.T >= since && x.Retr >= 0 {
			sum += x.Retr
			n++
		}
	}
	if n < 10 {
		return -1, n
	}
	return sum / float64(n), n
}
