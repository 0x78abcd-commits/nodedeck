package main

// 订阅端口的自签证书：没有 Let's Encrypt 证书（没开 HTTPS 订阅、或者还没申请下来）时，测速 / 查出口 IP / 被墙互查这些
// 接口照样能走 HTTPS。桌面端按证书指纹校验（指纹由 agent extra 报给桌面端），不依赖证书机构。
import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

func selfCertPaths(dataDir string) (string, string) {
	return filepath.Join(dataDir, "sub-self.crt"), filepath.Join(dataDir, "sub-self.key")
}

// loadSelfCert 读本机的自签证书，没有或快过期就重新生成（有效期 10 年）
func loadSelfCert(dataDir string) (*tls.Certificate, string, error) {
	cf, kf := selfCertPaths(dataDir)
	if c, err := tls.LoadX509KeyPair(cf, kf); err == nil && len(c.Certificate) > 0 {
		// 要能直接当信任根用（桌面端把它加进信任列表），所以必须是 CA 证书；老的不是就重新生成
		if leaf, err := x509.ParseCertificate(c.Certificate[0]); err == nil && leaf.IsCA && time.Until(leaf.NotAfter) > 30*24*time.Hour {
			return &c, certFP(c.Certificate[0]), nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, "", err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	tpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "nodedeck-sub"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true, MaxPathLenZero: true}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, "", err
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	_ = os.WriteFile(cf, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
	_ = os.WriteFile(kf, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0600)
	c := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	return &c, certFP(der), nil
}

func certFP(der []byte) string {
	s := sha256.Sum256(der)
	return hex.EncodeToString(s[:])
}
