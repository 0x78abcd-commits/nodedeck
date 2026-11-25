package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 一个极简的假 ACME 服务：校验 JWS 签名和 nonce，真的去 http-01 端口取验证文件，最后用测试 CA 签发 IP 证书
type fakeACME struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	nonces   map[string]bool
	acctKey  *ecdsa.PublicKey
	token    string
	valid    bool
	profile  string
	idType   string
	idValue  string
	certPEM  []byte
	caKey    *ecdsa.PrivateKey
	caCert   *x509.Certificate
	httpPort int
}

func (f *fakeACME) nonce() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	b := make([]byte, 8)
	rand.Read(b)
	n := base64.RawURLEncoding.EncodeToString(b)
	f.nonces[n] = true
	return n
}

func (f *fakeACME) verify(w http.ResponseWriter, r *http.Request) (map[string]any, []byte, bool) {
	var jws struct{ Protected, Payload, Signature string }
	if err := json.NewDecoder(r.Body).Decode(&jws); err != nil {
		http.Error(w, "bad jws", 400)
		return nil, nil, false
	}
	pb, _ := base64.RawURLEncoding.DecodeString(jws.Protected)
	var prot map[string]any
	json.Unmarshal(pb, &prot)
	n, _ := prot["nonce"].(string)
	f.mu.Lock()
	ok := f.nonces[n]
	delete(f.nonces, n)
	f.mu.Unlock()
	if !ok {
		w.Header().Set("Replay-Nonce", f.nonce())
		w.WriteHeader(400)
		io.WriteString(w, `{"type":"urn:ietf:params:acme:error:badNonce"}`)
		return nil, nil, false
	}
	if u, _ := prot["url"].(string); !strings.HasSuffix(u, r.URL.Path) {
		f.t.Errorf("JWS url %s 和请求地址 %s 不一致", u, r.URL.Path)
	}
	key := f.acctKey
	if jwk, ok := prot["jwk"].(map[string]any); ok {
		x, _ := base64.RawURLEncoding.DecodeString(jwk["x"].(string))
		y, _ := base64.RawURLEncoding.DecodeString(jwk["y"].(string))
		key = &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		f.acctKey = key
	} else if prot["kid"] == nil {
		f.t.Error("JWS 既没有 jwk 也没有 kid")
	}
	sig, _ := base64.RawURLEncoding.DecodeString(jws.Signature)
	h := sha256.Sum256([]byte(jws.Protected + "." + jws.Payload))
	if key == nil || len(sig) != 64 || !ecdsa.Verify(key, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		f.t.Error("JWS 签名校验失败")
		http.Error(w, "bad sig", 400)
		return nil, nil, false
	}
	payload, _ := base64.RawURLEncoding.DecodeString(jws.Payload)
	w.Header().Set("Replay-Nonce", f.nonce())
	return prot, payload, true
}

func newFakeACME(t *testing.T, httpPort int) *fakeACME {
	f := &fakeACME{t: t, nonces: map[string]bool{}, token: "tok-abc_123", httpPort: httpPort}
	f.caKey, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fake ACME CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, _ := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &f.caKey.PublicKey, f.caKey)
	f.caCert, _ = x509.ParseCertificate(der)
	mux := http.NewServeMux()
	base := func() string { return f.srv.URL }
	mux.HandleFunc("/dir", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"newNonce": base() + "/nonce", "newAccount": base() + "/acct", "newOrder": base() + "/order",
			"meta": map[string]any{"profiles": map[string]string{"classic": "90 天", "shortlived": "6 天"}}})
	})
	mux.HandleFunc("/nonce", func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Replay-Nonce", f.nonce()) })
	mux.HandleFunc("/acct", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := f.verify(w, r); ok {
			w.Header().Set("Location", base()+"/acct/1")
			w.WriteHeader(201)
			io.WriteString(w, `{"status":"valid"}`)
		}
	})
	mux.HandleFunc("/order", func(w http.ResponseWriter, r *http.Request) {
		_, p, ok := f.verify(w, r)
		if !ok {
			return
		}
		var o struct {
			Identifiers []struct{ Type, Value string }
			Profile     string
		}
		json.Unmarshal(p, &o)
		f.idType, f.idValue, f.profile = o.Identifiers[0].Type, o.Identifiers[0].Value, o.Profile
		w.Header().Set("Location", base()+"/order/1")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"status": "pending", "authorizations": []string{base() + "/authz/1"}, "finalize": base() + "/finalize/1"})
	})
	mux.HandleFunc("/authz/1", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := f.verify(w, r); ok {
			st := "pending"
			if f.valid {
				st = "valid"
			}
			json.NewEncoder(w).Encode(map[string]any{"status": st, "challenges": []map[string]string{{"type": "tls-alpn-01", "url": base() + "/chal/2", "token": "x"}, {"type": "http-01", "url": base() + "/chal/1", "token": f.token}}})
		}
	})
	mux.HandleFunc("/chal/1", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := f.verify(w, r); !ok {
			return
		}
		// 像真 CA 一样去取验证文件
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/.well-known/acme-challenge/%s", f.httpPort, f.token))
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			want := f.token + "." + thumb(f.acctKey)
			f.valid = string(b) == want
			if !f.valid {
				f.t.Errorf("验证文件内容不对：%q", b)
			}
		} else {
			f.t.Errorf("取验证文件失败：%v", err)
		}
		io.WriteString(w, `{"status":"processing"}`)
	})
	mux.HandleFunc("/finalize/1", func(w http.ResponseWriter, r *http.Request) {
		_, p, ok := f.verify(w, r)
		if !ok {
			return
		}
		var fin struct{ CSR string }
		json.Unmarshal(p, &fin)
		der, _ := base64.RawURLEncoding.DecodeString(fin.CSR)
		csr, err := x509.ParseCertificateRequest(der)
		if err != nil || csr.CheckSignature() != nil {
			f.t.Error("CSR 不对")
			return
		}
		tpl := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(160 * time.Hour), IPAddresses: csr.IPAddresses, DNSNames: csr.DNSNames, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
		cd, _ := x509.CreateCertificate(rand.Reader, tpl, f.caCert, csr.PublicKey, f.caKey)
		f.certPEM = append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cd}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.caCert.Raw})...)
		io.WriteString(w, `{"status":"processing"}`)
	})
	mux.HandleFunc("/order/1", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := f.verify(w, r); ok {
			if f.certPEM != nil {
				json.NewEncoder(w).Encode(map[string]any{"status": "valid", "certificate": base() + "/cert/1"})
			} else {
				io.WriteString(w, `{"status":"processing"}`)
			}
		}
	})
	mux.HandleFunc("/cert/1", func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := f.verify(w, r); ok {
			w.Write(f.certPEM)
		}
	})
	f.srv = httptest.NewTLSServer(mux)
	return f
}

func thumb(k *ecdsa.PublicKey) string {
	c := &acmeClient{key: &ecdsa.PrivateKey{PublicKey: *k}}
	return c.thumbprint()
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestACMEIPCertAndDualListener(t *testing.T) {
	dir := t.TempDir()
	httpPort := freePort(t)
	f := newFakeACME(t, httpPort)
	defer f.srv.Close()
	caFile := filepath.Join(dir, "acme-ca.pem")
	os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.srv.Certificate().Raw}), 0600)
	cfg := SubTLSCfg{Enabled: true, Host: "127.0.0.1", Directory: f.srv.URL + "/dir", CAFile: caFile, HTTPPort: httpPort}
	if err := obtainCert(cfg, dir); err != nil {
		t.Fatalf("申请证书失败：%v", err)
	}
	if f.idType != "ip" || f.idValue != "127.0.0.1" || f.profile != "shortlived" {
		t.Fatalf("订单不对：%s %s profile=%s", f.idType, f.idValue, f.profile)
	}
	info := subCertInfo(dir)
	if !info.OK || info.Host != "127.0.0.1" || info.Issuer != "Fake ACME CA" {
		t.Fatalf("证书状态不对：%+v", info)
	}
	// 验证完 80 端口要关掉
	if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", httpPort), time.Second); err == nil {
		c.Close()
		t.Fatal("验证结束后临时 http 端口还开着")
	}
	// 第二次申请复用账户密钥
	if err := obtainCert(cfg, dir); err != nil {
		t.Fatalf("续期失败：%v", err)
	}

	// 同一个端口：HTTPS 用新证书，HTTP 照常
	h := &certHolder{}
	cf, kf, _ := subCertPaths(dir)
	if err := h.load(cf, kf); err != nil {
		t.Fatal(err)
	}
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	tcfg := &tls.Config{GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { c, _ := h.get(); return c, nil }}
	mux := http.NewServeMux()
	mux.HandleFunc("/sub/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "ok tls=%v", r.TLS != nil)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(newDualListener(ln, tcfg))
	defer srv.Close()
	addr := ln.Addr().String()
	pool := x509.NewCertPool()
	pool.AddCert(f.caCert)
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}, Timeout: 5 * time.Second}
	resp, err := hc.Get("https://" + addr + "/sub/x")
	if err != nil {
		t.Fatalf("HTTPS 请求失败（证书应该对 IP 有效）：%v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "ok tls=true" {
		t.Fatalf("HTTPS 返回 %q", b)
	}
	resp, err = http.Get("http://" + addr + "/sub/x")
	if err != nil {
		t.Fatalf("HTTP 请求失败：%v", err)
	}
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "ok tls=false" {
		t.Fatalf("HTTP 返回 %q", b)
	}
}

func TestACMEPortBusy(t *testing.T) {
	dir := t.TempDir()
	busy, _ := net.Listen("tcp", "127.0.0.1:0")
	defer busy.Close()
	port := busy.Addr().(*net.TCPAddr).Port
	f := newFakeACME(t, port)
	defer f.srv.Close()
	caFile := filepath.Join(dir, "ca.pem")
	os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.srv.Certificate().Raw}), 0600)
	// 占着的是 127.0.0.1:port，监听 :port 在 Linux 上会失败
	err := obtainCert(SubTLSCfg{Host: "127.0.0.1", Directory: f.srv.URL + "/dir", CAFile: caFile, HTTPPort: port}, dir)
	if err == nil || !strings.Contains(err.Error(), "端口被占用") {
		t.Fatalf("端口被占用时应该给出明确提示，实际：%v", err)
	}
}
