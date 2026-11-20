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
	Sha256  map[string]string `json:"sha256"`
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
	if singboxVersion(bin) == m.Version {
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

func serviceActive(name string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", name).Run() == nil
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
	if m.Version == cur {
		msg := "已是最新版本 " + cur
		a.setUpdate(func(u *UpdateState) { u.Message = msg })
		return msg, nil
	}
	newBin, err := downloadSingbox(a.cfg.SingboxManifest, m, bin)
	if err != nil {
		return fail(err)
	}
	// 新版本必须能正常读取当前配置（防止新版删掉了旧字段）
	if b, err := exec.Command(newBin, "check", "-c", a.path("config.json")).CombinedOutput(); err != nil {
		os.Remove(newBin)
		return fail(fmt.Errorf("新版 %s 与当前配置不兼容，已跳过: %s", m.Version, strings.TrimSpace(string(b))))
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
	restart := func() { exec.Command("systemctl", "restart", a.cfg.Service).Run() }
	restart()
	time.Sleep(4 * time.Second)
	if !serviceActive(a.cfg.Service) {
		os.Rename(bin, bin+".bad")
		os.Rename(oldBin, bin)
		restart()
		return fail(fmt.Errorf("新版 %s 启动失败，已回滚到 %s", m.Version, cur))
	}
	msg := fmt.Sprintf("已从 %s 升级到 %s", cur, m.Version)
	a.setUpdate(func(u *UpdateState) { u.Current = m.Version; u.UpdatedAt = time.Now().Unix(); u.Message = msg })
	log.Print("sing-box " + msg)
	return msg, nil
}

func (a *Agent) updateLoop() {
	if !a.cfg.SingboxAutoUpdate {
		return
	}
	time.Sleep(2 * time.Minute)
	for {
		a.updateSingbox()
		time.Sleep(6 * time.Hour)
	}
}
