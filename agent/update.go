package main

// sing-box 内核自动升级：
//  1. 读取 manifest.json（版本号 + 各架构 gz 的 sha256），由 GitHub Actions 每天生成
//  2. 下载并校验 sha256，确认带 with_v2ray_api，且新版能通过当前配置的 check
//  3. 替换二进制并重启；服务起不来就自动回滚到旧版本
import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Manifest struct {
	Version string            `json:"version"`
	Tags    string            `json:"tags"`
	Sha256  map[string]string `json:"sha256"`
}

// singboxTags 读取已安装 sing-box 的编译选项（version 输出里的 Tags: 行）
func singboxTags(bin string) map[string]bool {
	out, _ := exec.Command(bin, "version").Output()
	m := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "Tags:") {
			for _, t := range strings.Split(strings.TrimPrefix(strings.TrimSpace(line), "Tags:"), ",") {
				if t = strings.TrimSpace(t); t != "" {
					m[t] = true
				}
			}
		}
	}
	return m
}

// needsUpdate 版本不同，或者渠道里的编译选项比已安装的多（比如新增了 with_wireguard）
func needsUpdate(m *Manifest, bin string) bool {
	if m.Version != singboxVersion(bin) {
		return true
	}
	if m.Tags == "" {
		return false
	}
	have := singboxTags(bin)
	for _, t := range strings.Split(m.Tags, ",") {
		if t = strings.TrimSpace(t); t != "" && !have[t] {
			return true
		}
	}
	return false
}

type UpdateState struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	CheckedAt int64  `json:"checkedAt"`
	UpdatedAt int64  `json:"updatedAt"`
	Message   string `json:"message"`
	Error     string `json:"error"`
}

var updateMu sync.Mutex

func singboxVersion(bin string) string {
	out, err := exec.Command(bin, "version").Output()
	if err != nil {
		return ""
	}
	// sing-box version 1.14.4
	f := strings.Fields(strings.SplitN(string(out), "\n", 2)[0])
	if len(f) >= 3 {
		return f[2]
	}
	return ""
}

func httpGet(url string, limit int64) ([]byte, error) {
	c := &http.Client{Timeout: 5 * time.Minute}
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s 返回 HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func baseURL(manifestURL string) string {
	i := strings.LastIndex(manifestURL, "/")
	if i < 0 {
		return manifestURL
	}
	return manifestURL[:i]
}

func fetchManifest(url string) (*Manifest, error) {
	raw, err := httpGet(url, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("读取版本信息失败: %w", err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil || m.Version == "" {
		return nil, fmt.Errorf("版本信息格式不对")
	}
	return &m, nil
}

// downloadSingbox 下载、校验 sha256、解压到 bin.new 并自检，返回新文件路径
func downloadSingbox(manifestURL string, m *Manifest, bin string) (string, error) {
	want := strings.ToLower(m.Sha256[runtime.GOARCH])
	if want == "" {
		return "", fmt.Errorf("版本信息里没有 %s 架构", runtime.GOARCH)
	}
	gz, err := httpGet(fmt.Sprintf("%s/nodedeck-sing-box-linux-%s.gz", baseURL(manifestURL), runtime.GOARCH), 200<<20)
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
	out, _ := exec.Command(newBin, "version").CombinedOutput()
	if !strings.Contains(string(out), "with_v2ray_api") || singboxVersion(newBin) != m.Version {
		os.Remove(newBin)
		return "", fmt.Errorf("新版本自检失败（版本号或编译选项不对）")
	}
	return newBin, nil
}

// installSingbox 部署时使用：版本不同就安装（不重启服务）
func installSingbox(manifestURL, bin string) (string, error) {
	m, err := fetchManifest(manifestURL)
	if err != nil {
		return "", err
	}
	if !needsUpdate(m, bin) {
		return m.Version, nil
	}
	newBin, err := downloadSingbox(manifestURL, m, bin)
	if err != nil {
		return "", err
	}
	return m.Version, os.Rename(newBin, bin)
}

func (a *Agent) setUpdate(f func(*UpdateState)) {
	a.mu.Lock()
	f(&a.update)
	a.mu.Unlock()
}

// updateSingbox 检查并升级；返回给人看的结果说明
func (a *Agent) updateSingbox() (string, error) {
	updateMu.Lock()
	defer updateMu.Unlock()
	bin := a.cfg.SingBox
	cur := singboxVersion(bin)
	a.setUpdate(func(u *UpdateState) { u.Current = cur; u.CheckedAt = time.Now().Unix(); u.Error = "" })
	fail := func(err error) (string, error) {
		a.setUpdate(func(u *UpdateState) { u.Error = err.Error() })
		log.Printf("sing-box 升级: %v", err)
		return "", err
	}
	if a.cfg.SingboxManifest == "" {
		return fail(fmt.Errorf("没有配置 singboxManifest"))
	}
	m, err := fetchManifest(a.cfg.SingboxManifest)
	if err != nil {
		return fail(err)
	}
	a.setUpdate(func(u *UpdateState) { u.Latest = m.Version })
	if !needsUpdate(m, bin) {
		msg := "已是最新版本 " + cur
		a.setUpdate(func(u *UpdateState) { u.Message = msg })
		return msg, nil
	}
	newBin, err := downloadSingbox(a.cfg.SingboxManifest, m, bin)
	if err != nil {
		return fail(err)
	}
	// 新版本必须能正常读取当前所有配置（防止新版删掉了旧字段）
	for _, f := range []string{"config.json", "config.full.json", "cf.json"} {
		if _, err := os.Stat(a.path(f)); err != nil {
			continue
		}
		if b, err := exec.Command(newBin, "check", "-c", a.path(f)).CombinedOutput(); err != nil {
			os.Remove(newBin)
			return fail(fmt.Errorf("新版 %s 与当前配置 %s 不兼容，已跳过: %s", m.Version, f, strings.TrimSpace(string(b))))
		}
	}
	a.poll() // 重启会清零计数，先收集
	oldBin := bin + ".old"
	os.Remove(oldBin)
	if err := os.Rename(bin, oldBin); err != nil {
		os.Remove(newBin)
		return fail(err)
	}
	if err := os.Rename(newBin, bin); err != nil {
		os.Rename(oldBin, bin)
		return fail(err)
	}
	restart := func() { _ = a.svcRestart(a.cfg.Service) }
	restart()
	time.Sleep(4 * time.Second)
	if !a.svcActive(a.cfg.Service) {
		os.Rename(bin, bin+".bad")
		os.Rename(oldBin, bin)
		restart()
		return fail(fmt.Errorf("新版 %s 启动失败，已回滚到 %s", m.Version, cur))
	}
	// Cloudflare 隧道是同一个内核跑的独立服务，也要重启才会用上新内核
	if _, err := os.Stat(a.path("cf.json")); err == nil && a.svcActive("nodedeck-cf") {
		_ = a.svcRestart("nodedeck-cf")
	}
	msg := fmt.Sprintf("已从 %s 升级到 %s", cur, m.Version)
	if cur == m.Version {
		msg = fmt.Sprintf("已更新 sing-box %s（新增编译选项：%s）", m.Version, m.Tags)
	}
	a.setUpdate(func(u *UpdateState) { u.Current = m.Version; u.UpdatedAt = time.Now().Unix(); u.Message = msg })
	log.Print("sing-box " + msg)
	return msg, nil
}

// inWindow 当前是否在允许自动升级的时间段内
func (a *Agent) inWindow(now time.Time) bool {
	w := a.cfg.UpgradeWindow
	if len(w) != 2 || w[0] == w[1] {
		return true
	}
	h := now.In(a.loc()).Hour()
	if w[0] < w[1] {
		return h >= w[0] && h < w[1]
	}
	return h >= w[0] || h < w[1] // 跨零点，如 23-5
}

func (a *Agent) updateLoop() {
	if !a.cfg.SingboxAutoUpdate {
		return
	}
	time.Sleep(2 * time.Minute)
	var last time.Time
	for {
		now := time.Now()
		if a.inWindow(now) && now.Sub(last) >= 6*time.Hour {
			last = now
			msg, err := a.updateSingbox()
			a.mu.Lock()
			if err != nil {
				a.notifyOnce("sb-err:"+a.update.Latest+":"+err.Error(), "⚠️ sing-box 自动升级没有完成："+err.Error())
			} else if strings.HasPrefix(msg, "已从") || strings.HasPrefix(msg, "已更新") {
				a.notifyOnce("sb-ok:"+a.update.Current, "⬆️ sing-box "+msg)
			}
			a.mu.Unlock()
		}
		time.Sleep(30 * time.Minute)
	}
}
