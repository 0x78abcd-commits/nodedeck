package main

// 服务管理：systemd（Debian / Ubuntu / CentOS …）和 OpenRC（Alpine）
import (
	"fmt"
	"os/exec"
)

func (a *Agent) isOpenRC() bool { return a.cfg.Init == "openrc" }

func runSh(script string) ([]byte, error) { return exec.Command("sh", "-c", script).CombinedOutput() }

func (a *Agent) svcReload(name string) error {
	var out []byte
	var err error
	if a.isOpenRC() {
		out, err = runSh(fmt.Sprintf("if rc-service %[1]s status >/dev/null 2>&1; then rc-service %[1]s reload; else rc-service %[1]s restart; fi", name))
	} else {
		out, err = exec.Command("systemctl", "reload-or-restart", name).CombinedOutput()
	}
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

func (a *Agent) svcRestart(name string) error {
	var out []byte
	var err error
	if a.isOpenRC() {
		out, err = exec.Command("rc-service", name, "restart").CombinedOutput()
	} else {
		out, err = exec.Command("systemctl", "restart", name).CombinedOutput()
	}
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

func (a *Agent) svcActive(name string) bool {
	if a.isOpenRC() {
		return exec.Command("rc-service", name, "status").Run() == nil
	}
	return exec.Command("systemctl", "is-active", "--quiet", name).Run() == nil
}
