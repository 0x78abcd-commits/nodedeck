package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolvWriteRestore(t *testing.T) {
	d := t.TempDir()
	oldR, oldH := resolvConf, dhclientHook
	defer func() { resolvConf, dhclientHook = oldR, oldH }()
	resolvConf = filepath.Join(d, "resolv.conf")
	os.MkdirAll(filepath.Join(d, "hooks"), 0755)
	dhclientHook = filepath.Join(d, "hooks", "nodedeck-dns")

	// 1. 普通文件，原 DNS 连不上：还原时保留新的
	os.WriteFile(resolvConf, []byte("nameserver 192.0.2.1\n"), 0644)
	if err := writeResolv(d, []string{"1.1.1.1", "8.8.8.8"}); err != nil {
		t.Fatal(err)
	}
	if ns := readNameservers(resolvConf); strings.Join(ns, ",") != "1.1.1.1,8.8.8.8" {
		t.Fatalf("写入不对: %v", ns)
	}
	if _, err := os.Stat(dhclientHook); err != nil {
		t.Fatal("没有写 dhclient 钩子")
	}
	// 再写一次不能覆盖最初的备份
	writeResolv(d, []string{"9.9.9.9"})
	if ns := readNameservers(filepath.Join(d, "resolv.conf.orig")); len(ns) != 1 || ns[0] != "192.0.2.1" {
		t.Fatalf("备份被覆盖了: %v", ns)
	}
	if err := restoreDNS(d); err == nil || !strings.Contains(err.Error(), "保留") {
		t.Fatalf("原 DNS 不通时应该保留现在的: %v", err)
	}
	if ns := readNameservers(resolvConf); ns[0] != "9.9.9.9" {
		t.Fatalf("不该还原: %v", ns)
	}

	// 2. 原来是链接：还原成链接
	os.Remove(resolvConf)
	os.WriteFile(filepath.Join(d, "stub"), []byte("nameserver 127.0.0.53\n"), 0644)
	os.Symlink(filepath.Join(d, "stub"), resolvConf)
	if err := writeResolv(d, []string{"1.1.1.1"}); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Lstat(resolvConf); fi.Mode()&os.ModeSymlink != 0 {
		t.Fatal("链接没被替换成文件")
	}
	if err := restoreDNS(d); err != nil {
		t.Fatal(err)
	}
	if tgt, err := os.Readlink(resolvConf); err != nil || tgt != filepath.Join(d, "stub") {
		t.Fatalf("没还原成链接: %v %v", tgt, err)
	}
	if _, err := os.Stat(dhclientHook); err == nil {
		t.Fatal("钩子没删")
	}
}
