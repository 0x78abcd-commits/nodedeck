package main

// 系统 DNS 自检和修复：有的 VPS 模板里 /etc/resolv.conf 写的是内网地址（比如 192.168.10.1），
// 这台机器根本连不上，结果下载内核、申请证书、sing-box 解析用户访问的域名全都失败。
// 部署时先检查，解析不了就换成能用的公共 DNS（原文件备份，卸载时还原）。
import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var resolvConf = "/etc/resolv.conf"
var dhclientHook = "/etc/dhcp/dhclient-enter-hooks.d/nodedeck-dns"

// 按顺序试，最多用两个能通的
var publicDNS = []string{"1.1.1.1", "8.8.8.8", "9.9.9.9", "208.67.222.222", "2606:4700:4700::1111", "2001:4860:4860::8888"}

var dnsTestHosts = []string{"github.com", "www.cloudflare.com"}

type DNSResult struct {
	OK      bool     `json:"ok"`
	Fixed   bool     `json:"fixed"`
	Old     []string `json:"old"` // 原来的 DNS 服务器
	New     []string `json:"new"` // 换成的
	Error   string   `json:"error,omitempty"`
	Resolve string   `json:"resolve"` // 测试解析得到的地址
}

func readNameservers(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, l := range strings.Split(string(b), "\n") {
		f := strings.Fields(l)
		if len(f) >= 2 && f[0] == "nameserver" {
			out = append(out, f[1])
		}
	}
	return out
}

func lookupWith(r *net.Resolver, timeout time.Duration) (string, error) {
	var last error
	for _, h := range dnsTestHosts {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		ips, err := r.LookupIPAddr(ctx, h)
		cancel()
		if err == nil && len(ips) > 0 {
			return ips[0].IP.String(), nil
		}
		last = err
	}
	if last == nil {
		last = errors.New("没有解析结果")
	}
	return "", last
}

// 只用指定 DNS 服务器的解析器（不读 resolv.conf）
func resolverFor(server string) *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		d := net.Dialer{Timeout: 3 * time.Second}
		return d.DialContext(ctx, network, net.JoinHostPort(server, "53"))
	}}
}

// systemResolver 每次新建，确保读的是当前的 resolv.conf
func systemResolver() *net.Resolver { return &net.Resolver{PreferGo: true} }

func checkDNS() DNSResult {
	r := DNSResult{Old: readNameservers(resolvConf)}
	ip, err := lookupWith(systemResolver(), 5*time.Second)
	if err == nil {
		r.OK, r.Resolve = true, ip
		return r
	}
	r.Error = err.Error()
	return r
}

// fixDNS 系统 DNS 不能用时换成能通的公共 DNS
func fixDNS(dataDir string) DNSResult {
	r := checkDNS()
	if r.OK {
		return r
	}
	var good []string
	for _, s := range publicDNS {
		if _, err := lookupWith(resolverFor(s), 3*time.Second); err == nil {
			good = append(good, s)
			if len(good) == 2 {
				break
			}
		}
	}
	if len(good) == 0 {
		r.Error = fmt.Sprintf("系统 DNS（%s）解析不了域名，公共 DNS（1.1.1.1、8.8.8.8 等）也都连不上：VPS 可能还没通外网，或者服务商拦了 DNS。请到服务商后台检查网络设置", strings.Join(r.Old, "、"))
		return r
	}
	if err := writeResolv(dataDir, good); err != nil {
		r.Error = "改写 /etc/resolv.conf 失败：" + err.Error()
		return r
	}
	r.New, r.Fixed = good, true
	time.Sleep(6 * time.Second) // Go 的解析器最多每 5 秒重新读一次 resolv.conf，等它读到新文件再验证
	ip, err := lookupWith(systemResolver(), 5*time.Second)
	if err != nil {
		r.Error = "已换成 " + strings.Join(good, "、") + "，但系统解析仍然失败：" + err.Error()
		return r
	}
	r.OK, r.Resolve, r.Error = true, ip, ""
	return r
}

func writeResolv(dataDir string, servers []string) error {
	bak := filepath.Join(dataDir, "resolv.conf.orig")
	if _, err := os.Lstat(bak); err != nil {
		// 备份：原来是链接（systemd-resolved 等）就记下链接目标，否则存原文件内容
		if t, err := os.Readlink(resolvConf); err == nil {
			_ = os.WriteFile(bak, []byte("#symlink "+t+"\n"), 0600)
		} else if b, err := os.ReadFile(resolvConf); err == nil {
			_ = os.WriteFile(bak, b, 0600)
		} else {
			_ = os.WriteFile(bak, []byte("#none\n"), 0600)
		}
	}
	var sb strings.Builder
	sb.WriteString("# NodeDeck：原来的 DNS 服务器连不上，换成了公共 DNS（卸载 NodeDeck 时还原，原文件在 " + bak + "）\n")
	for _, s := range servers {
		sb.WriteString("nameserver " + s + "\n")
	}
	sb.WriteString("options timeout:2 attempts:2\n")
	tmp := resolvConf + ".nodedeck"
	if err := os.WriteFile(tmp, []byte(sb.String()), 0644); err != nil {
		return err
	}
	// 原来是链接的话，rename 会替换掉链接本身，之后 systemd-resolved 不会再改它
	if err := os.Rename(tmp, resolvConf); err != nil {
		os.Remove(tmp)
		return err
	}
	// Debian 的 dhclient 续租时会重写 resolv.conf，加个钩子不让它改
	if st, err := os.Stat(filepath.Dir(dhclientHook)); err == nil && st.IsDir() {
		_ = os.WriteFile(dhclientHook, []byte("# NodeDeck：不让 dhclient 改写 /etc/resolv.conf\nmake_resolv_conf() { :; }\n"), 0644)
	}
	return nil
}

// restoreDNS 卸载时还原
func restoreDNS(dataDir string) error {
	bak := filepath.Join(dataDir, "resolv.conf.orig")
	b, err := os.ReadFile(bak)
	if err != nil {
		return nil // 没改过
	}
	s := string(b)
	// 原来的 DNS 现在还是用不了的话，还原回去只会让这台机器又解析不了域名：保留现在能用的
	if old := readNameservers(bak); !strings.HasPrefix(s, "#") && len(old) > 0 {
		works := false
		for _, o := range old {
			if _, err := lookupWith(resolverFor(o), 3*time.Second); err == nil {
				works = true
				break
			}
		}
		if !works {
			os.Remove(bak)
			return fmt.Errorf("原来的 DNS（%s）仍然连不上，保留现在的设置", strings.Join(old, "、"))
		}
	}
	os.Remove(dhclientHook)
	switch {
	case strings.HasPrefix(s, "#symlink "):
		target := strings.TrimSpace(strings.TrimPrefix(s, "#symlink "))
		tmp := resolvConf + ".nodedeck"
		os.Remove(tmp)
		if err := os.Symlink(target, tmp); err != nil {
			return err
		}
		if err := os.Rename(tmp, resolvConf); err != nil {
			return err
		}
	case s == "#none\n":
		os.Remove(resolvConf)
	default:
		if err := os.WriteFile(resolvConf, b, 0644); err != nil {
			return err
		}
	}
	return os.Remove(bak)
}
