package main

import (
	"crypto/x509"
	"testing"
)

func TestSelfCert(t *testing.T) {
	dir := t.TempDir()
	c1, fp1, err := loadSelfCert(dir)
	if err != nil || c1 == nil || fp1 == "" {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(c1.Certificate[0])
	if !leaf.IsCA {
		t.Fatal("自签证书要能当信任根")
	}
	_, fp2, _ := loadSelfCert(dir)
	if fp1 != fp2 {
		t.Fatal("第二次应该复用同一张证书")
	}
}
