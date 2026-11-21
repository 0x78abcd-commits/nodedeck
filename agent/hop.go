package main

// Hysteria2 端口跳跃：用 iptables 把一段 UDP 端口转到 Hy2 的真实端口
// 规则带注释 nodedeck-hop，每次先清掉旧规则再加新规则；agent 启动时自动恢复（重启 VPS 后也生效）
import (
	"fmt"
	"log"
	"os/exec"
	"strings"
)

type UDPHop struct {
	From int `json:"from"`
	To   int `json:"to"`
	Port int `json:"port"`
}

const hopComment = "nodedeck-hop"

func clearHops(bin string) {
	out, err := exec.Command(bin, "-t", "nat", "-S", "PREROUTING").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, hopComment) || !strings.HasPrefix(line, "-A ") {
			continue
		}
		args := append([]string{"-t", "nat", "-D"}, splitRule(strings.TrimPrefix(line, "-A "))...)
		if b, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
			log.Printf("删除旧端口跳跃规则失败: %v %s", err, b)
		}
	}
}

// iptables -S 输出的注释可能带引号
func splitRule(s string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	for _, r := range s {
		switch {
		case r == '"':
			quoted = !quoted
		case r == ' ' && !quoted:
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func (a *Agent) applyHops() {
	for _, bin := range []string{"iptables", "ip6tables"} {
		if _, err := exec.LookPath(bin); err != nil {
			if bin == "iptables" && len(a.cfg.UDPHops) > 0 {
				log.Printf("系统没有 iptables，Hysteria2 端口跳跃不可用")
			}
			continue
		}
		clearHops(bin)
		for _, h := range a.cfg.UDPHops {
			if h.From <= 0 || h.To <= h.From || h.Port <= 0 {
				continue
			}
			args := []string{"-t", "nat", "-A", "PREROUTING", "-p", "udp", "--dport", fmt.Sprintf("%d:%d", h.From, h.To),
				"-m", "comment", "--comment", hopComment, "-j", "REDIRECT", "--to-ports", fmt.Sprint(h.Port)}
			if b, err := exec.Command(bin, args...).CombinedOutput(); err != nil {
				log.Printf("%s 添加端口跳跃规则失败: %v %s", bin, err, b)
			}
		}
	}
}
