package main

// 端口来源白名单：指定端口只允许名单里的 IP / 网段连，其余在系统防火墙层面直接丢弃（扫端口看不到服务）。
// 用在两种地方：一定要用常用 Web 端口（80 / 443 / 8080 / 8443）的协议（很多服务商要求这种情况只对指定 IP 开放），
// 和填了来源白名单的端口转发。规则带注释 nodedeck-allow，每次先清掉旧的再加；agent 启动时自动恢复（重启 VPS 后也生效）
import (
	"fmt"
	"log"
	"net"
	"os/exec"
	"strings"
)

type PortAllow struct {
	Port  int      `json:"port"`
	Net   string   `json:"net"`   // tcp / udp / both
	Allow []string `json:"allow"` // IP 或网段
}

const allowComment = "nodedeck-allow"

func clearAllow(bin string) {
	out, err := exec.Command(bin, "-S", "INPUT").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, allowComment) || !strings.HasPrefix(line, "-A ") {
			continue
		}
		args := append([]string{"-D"}, splitRule(strings.TrimPrefix(line, "-A "))...)
		if b, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
			log.Printf("删除旧白名单规则失败: %v %s", err, b)
		}
	}
}

// 某个地址族（v6=false 给 iptables，true 给 ip6tables）要加的规则，按插入顺序排好：
// 先插 DROP，再插 ACCEPT（都用 -I INPUT 1，后插的在前面），最终 ACCEPT 在 DROP 前面、也在 ufw 等规则前面
func allowRules(rules []PortAllow, v6 bool) [][]string {
	var drops, accepts [][]string
	for _, r := range rules {
		if r.Port <= 0 || r.Port > 65535 || len(r.Allow) == 0 {
			continue
		}
		nets := []string{"tcp", "udp"}
		if r.Net == "tcp" || r.Net == "udp" {
			nets = []string{r.Net}
		}
		var srcs []string
		for _, a := range r.Allow {
			a = strings.TrimSpace(a)
			ip := net.ParseIP(a)
			if ip == nil {
				_, n, err := net.ParseCIDR(a)
				if err != nil {
					continue
				}
				ip = n.IP
			}
			if (ip.To4() == nil) == v6 {
				srcs = append(srcs, a)
			}
		}
		for _, n := range nets {
			base := []string{"-p", n, "--dport", fmt.Sprint(r.Port)}
			drops = append(drops, append(append([]string{"-I", "INPUT", "1"}, base...), "-m", "comment", "--comment", allowComment, "-j", "DROP"))
			for _, s := range srcs {
				accepts = append(accepts, append(append([]string{"-I", "INPUT", "1"}, base...), "-s", s, "-m", "comment", "--comment", allowComment, "-j", "ACCEPT"))
			}
		}
	}
	return append(drops, accepts...)
}

func (a *Agent) applyAllow() {
	for _, bin := range []string{"iptables", "ip6tables"} {
		if _, err := exec.LookPath(bin); err != nil {
			if bin == "iptables" && len(a.cfg.PortAllow) > 0 {
				log.Printf("系统没有 iptables，端口来源白名单不可用")
			}
			continue
		}
		clearAllow(bin)
		for _, args := range allowRules(a.cfg.PortAllow, bin == "ip6tables") {
			if b, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
				log.Printf("%s 添加白名单规则失败: %v %s", bin, err, b)
			}
		}
	}
}
