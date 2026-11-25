package main

// Xray 内核：只在开了 XHTTP 协议（VLESS-XHTTP-Reality / VLESS-XHTTP-TLS）时用。
//   - 桌面端写 xray.full.json（含已停用用户），agent 去掉停用用户写成 xray.json，`xray run -test` 通过才换上
//   - Xray 不支持热重载：内容（或它读的证书文件）变了才重启 nodedeck-xray，没变不动，避免断开连接
//   - Xray 收到的流量经本机 socks 交给 sing-box，流量统计按用户从 Xray 的 StatsService 读
//   - 内核升级和 sing-box 一样：manifest.json 给版本号和各架构 gz 的 sha256，升级失败自动回滚
import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type XrayCfg struct {
	Bin      string `json:"bin"`
	Service  string `json:"service"`
	StatsAPI string `json:"statsApi"`
	Manifest string `json:"manifest"`
}

type XrayStatus struct {
	Running bool        `json:"running"`
	Error   string      `json:"error,omitempty"`
	Update  UpdateState `json:"update"`
}

const xrayStatsPath = "/xray.app.stats.command.StatsService/QueryStats"

func (a *Agent) xrayBin() string {
	if a.cfg.Xray != nil && a.cfg.Xray.Bin != "" {
		return a.cfg.Xray.Bin
	}
	return "/usr/local/bin/nodedeck-xray"
}

func (a *Agent) xrayService() string {
	if a.cfg.Xray != nil && a.cfg.Xray.Service != "" {
		return a.cfg.Xray.Service
	}
	return "nodedeck-xray"
}

// queryXrayStats 没开 Xray 时返回 nil, nil
func (a *Agent) queryXrayStats() (map[string]int64, error) {
	if a.cfg.Xray == nil || a.cfg.Xray.StatsAPI == "" {
		return nil, nil
	}
	if _, err := os.Stat(a.path("xray.json")); err != nil {
		return nil, nil
	}
	return queryStatsAt(a.cfg.Xray.StatsAPI, xrayStatsPath)
}

func (a *Agent) xrayStatus() *XrayStatus {
	if a.cfg.Xray == nil {
		return nil
	}
	a.mu.Lock()
	st := &XrayStatus{Error: a.xrayErr, Update: a.xrayUpdate}
	a.mu.Unlock()
	st.Running = a.svcActive(a.xrayService())
	return st
}

// filterXray 去掉停用用户（按 email = 用户 id）
func filterXray(full []byte, disabled map[string]string) ([]byte, error) {
	var cfg map[string]any
	if err := json.Unmarshal(full, &cfg); err != nil {
		return nil, err
	}
	inbounds, _ := cfg["inbounds"].([]any)
	for _, ib := range inbounds {
		m, _ := ib.(map[string]any)
		st, _ := m["settings"].(map[string]any)
		clients, ok := st["clients"].([]any)
		if !ok {
			continue
		}
		kept := make([]any, 0, len(clients))
		for _, c := range clients {
			cm, _ := c.(map[string]any)
			email, _ := cm["email"].(string)
			if _, off := disabled[email]; off {
				continue
			}
			kept = append(kept, c)
		}
		st["clients"] = kept
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// xrayCertFiles 配置里引用的证书文件（证书续期后内容会变，要重启 Xray 才会读新的）
func xrayCertFiles(cfgJSON []byte) []string {
	var cfg struct {
		Inbounds []struct {
			StreamSettings struct {
				TLSSettings struct {
					Certificates []struct {
						CertificateFile string `json:"certificateFile"`
						KeyFile         string `json:"keyFile"`
					} `json:"certificates"`
				} `json:"tlsSettings"`
			} `json:"streamSettings"`
		} `json:"inbounds"`
	}
	_ = json.Unmarshal(cfgJSON, &cfg)
	var out []string
	for _, ib := range cfg.Inbounds {
		for _, c := range ib.StreamSettings.TLSSettings.Certificates {
			out = append(out, c.CertificateFile, c.KeyFile)
		}
	}
	return out
}

func xrayDigest(cfgJSON []byte) (string, bool) {
	h := sha256.New()
	h.Write(cfgJSON)
	ok := true
	for _, f := range xrayCertFiles(cfgJSON) {
		b, err := os.ReadFile(f)
		if err != nil {
			ok = false // 证书还没申请下来（正式证书），先不启动
		}
		h.Write([]byte(f))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil)), ok
}

// applyXray 每 15 秒和每次同步都会调用：内容没变就什么都不做
func (a *Agent) applyXray() error {
	if a.cfg.Xray == nil {
		return nil
	}
	full, err := os.ReadFile(a.path("xray.full.json"))
	if err != nil {
		return nil // 桌面端还没推配置
	}
	a.mu.Lock()
	disabled := a.disabled
	a.mu.Unlock()
	out, err := filterXray(full, disabled)
	if err != nil {
		return fmt.Errorf("xray.full.json 格式不对: %w", err)
	}
	sig, certsOK := xrayDigest(out)
	a.mu.Lock()
	same := sig == a.xrayApplied
	a.mu.Unlock()
	svc := a.xrayService()
	if same {
		if a.svcActive(svc) {
			return nil
		}
		// 配置没变但服务没起来（比如端口被占）：systemd 自己会重试，这里每 5 分钟才再试一次，避免日志刷屏
		if time.Since(a.xrayTried) < 5*time.Minute {
			return nil
		}
	}
	a.xrayTried = time.Now()
	if !certsOK {
		return fmt.Errorf("XHTTP-TLS 用的证书文件还不存在（正式证书可能还在申请），稍后自动重试")
	}
	// 刚启动：磁盘上的 xray.json 和要写的一样且服务在跑，就不重启
	if cur, err := os.ReadFile(a.path("xray.json")); err == nil && bytes.Equal(cur, out) && a.svcActive(svc) {
		a.mu.Lock()
		a.xrayApplied = sig
		a.mu.Unlock()
		return nil
	}
	tmp := a.path("xray.check.json")
	if err := os.WriteFile(tmp, out, 0600); err != nil {
		return err
	}
	if b, err := exec.Command(a.xrayBin(), "run", "-test", "-c", tmp).CombinedOutput(); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("Xray 配置校验失败: %s", lastLines(string(b), 3))
	}
	if err := os.Rename(tmp, a.path("xray.json")); err != nil {
		return err
	}
	a.poll() // 重启会清零 Xray 的计数，先收上来
	if err := a.svcRestart(svc); err != nil {
		return fmt.Errorf("重启 Xray 失败: %w", err)
	}
	a.mu.Lock()
	a.xrayApplied = sig
	a.xrayErr = ""
	a.mu.Unlock()
	log.Printf("已应用 Xray 配置")
	return nil
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

// xrayVersion "Xray 26.11.9 (Xray, Penetrates Everything.) ..." → 26.11.9
func xrayVersion(bin string) string {
	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		return ""
	}
	f := strings.Fields(strings.SplitN(string(out), "\n", 2)[0])
	if len(f) >= 2 && f[0] == "Xray" {
		return f[1]
	}
	return ""
}

// downloadXray 下载、校验 sha256、解压到 bin.new 并自检
func downloadXray(manifestURL string, m *Manifest, bin string) (string, error) {
	if free := diskFreeMB(filepath.Dir(bin)); free > 0 && free < 150 {
		return "", fmt.Errorf("磁盘只剩 %dMB，不够安装 Xray（至少要 150MB）", free)
	}
	want := strings.ToLower(m.Sha256[runtime.GOARCH])
	if want == "" {
		return "", fmt.Errorf("Xray 版本信息里没有 %s 架构", runtime.GOARCH)
	}
	gz, err := httpGet(fmt.Sprintf("%s/nodedeck-xray-linux-%s.gz", baseURL(manifestURL), runtime.GOARCH), 200<<20)
	if err != nil {
		return "", fmt.Errorf("下载失败: %w", err)
	}
	sum := sha256.Sum256(gz)
	if hex.EncodeToString(sum[:]) != want {
		return "", fmt.Errorf("sha256 校验不通过，已放弃")
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return "", err
	}
	newBin := bin + ".new"
	f, err := os.OpenFile(newBin, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, zr)
	f.Close()
	if err != nil {
		os.Remove(newBin)
		return "", err
	}
	if v := xrayVersion(newBin); v != m.Version {
		os.Remove(newBin)
		return "", fmt.Errorf("新版本自检失败（版本号 %q 不对）", v)
	}
	return newBin, nil
}

// installXray 部署时用：版本不同就安装（不重启服务）
func installXray(manifestURL, bin string) (string, error) {
	if manifestURL == "" {
		return "", fmt.Errorf("没有 Xray 版本信息地址")
	}
	m, err := fetchManifest(manifestURL)
	if err != nil {
		return "", err
	}
	if xrayVersion(bin) == m.Version {
		return m.Version, nil
	}
	newBin, err := downloadXray(manifestURL, m, bin)
	if err != nil {
		return "", err
	}
	return m.Version, os.Rename(newBin, bin)
}

func (a *Agent) setXrayUpdate(f func(*UpdateState)) {
	a.mu.Lock()
	f(&a.xrayUpdate)
	a.mu.Unlock()
}

// updateXray 检查并升级 Xray；新版本必须能读当前配置，起不来自动回滚
func (a *Agent) updateXray() (string, error) {
	if a.cfg.Xray == nil {
		return "", fmt.Errorf("这台服务器没有开 XHTTP 协议，不用 Xray")
	}
	updateMu.Lock()
	defer updateMu.Unlock()
	bin := a.xrayBin()
	cur := xrayVersion(bin)
	a.setXrayUpdate(func(u *UpdateState) { u.Current = cur; u.CheckedAt = time.Now().Unix(); u.Error = "" })
	fail := func(err error) (string, error) {
		a.setXrayUpdate(func(u *UpdateState) { u.Error = err.Error() })
		log.Printf("Xray 升级: %v", err)
		return "", err
	}
	if a.cfg.Xray.Manifest == "" {
		return fail(fmt.Errorf("没有配置 Xray 版本信息地址"))
	}
	m, err := fetchManifest(a.cfg.Xray.Manifest)
	if err != nil {
		return fail(err)
	}
	a.setXrayUpdate(func(u *UpdateState) { u.Latest = m.Version })
	if cur == m.Version {
		msg := "已是最新版本 " + cur
		a.setXrayUpdate(func(u *UpdateState) { u.Message = msg })
		return msg, nil
	}
	newBin, err := downloadXray(a.cfg.Xray.Manifest, m, bin)
	if err != nil {
		return fail(err)
	}
	if _, err := os.Stat(a.path("xray.json")); err == nil {
		if b, err := exec.Command(newBin, "run", "-test", "-c", a.path("xray.json")).CombinedOutput(); err != nil {
			os.Remove(newBin)
			return fail(fmt.Errorf("新版 Xray %s 与当前配置不兼容，已跳过: %s", m.Version, lastLines(string(b), 2)))
		}
	}
	a.poll()
	oldBin := bin + ".old"
	os.Remove(oldBin)
	hadOld := os.Rename(bin, oldBin) == nil
	if err := os.Rename(newBin, bin); err != nil {
		if hadOld {
			os.Rename(oldBin, bin)
		}
		return fail(err)
	}
	svc := a.xrayService()
	_ = a.svcRestart(svc)
	time.Sleep(4 * time.Second)
	if _, err := os.Stat(a.path("xray.json")); err == nil && !a.svcActive(svc) && hadOld {
		os.Rename(bin, bin+".bad")
		os.Rename(oldBin, bin)
		_ = a.svcRestart(svc)
		return fail(fmt.Errorf("新版 Xray %s 启动失败，已回滚到 %s", m.Version, cur))
	}
	msg := fmt.Sprintf("Xray 已从 %s 升级到 %s", cur, m.Version)
	if cur == "" {
		msg = "已安装 Xray " + m.Version
	}
	a.setXrayUpdate(func(u *UpdateState) { u.Current = m.Version; u.UpdatedAt = time.Now().Unix(); u.Message = msg })
	log.Print(msg)
	return msg, nil
}
