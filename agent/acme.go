package main

// 订阅走 HTTPS，不需要域名：向 Let's Encrypt 申请「IP 地址证书」（只有 6 天有效期的 shortlived 证书，
// 所以每 3 天左右自动续一次）。只用标准库实现 ACME（RFC 8555）的 http-01 验证：
// 验证时临时在 80 端口回答一个文件，验证完就关掉。
// 订阅端口同时接受 HTTP 和 HTTPS（看第一个字节分辨），以前发出去的 http 订阅地址继续能用。
import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const leDirectory = "https://acme-v02.api.letsencrypt.org/directory"

// SubTLSCfg 订阅 HTTPS 设置（桌面端写进 agent.json）
type SubTLSCfg struct {
	Enabled   bool   `json:"enabled"`
	Host      string `json:"host"`      // 证书上的地址：VPS 的公网 IP（或域名）
	Directory string `json:"directory"` // ACME 服务地址，默认 Let's Encrypt 正式环境
	Email     string `json:"email"`
	CAFile    string `json:"caFile"` // 仅测试用：信任 ACME 服务的自定义根证书
	HTTPPort  int    `json:"httpPort"`
}

// SubCertStatus 给桌面端看的证书状态
type SubCertStatus struct {
	OK        bool   `json:"ok"`
	Host      string `json:"host"`
	NotAfter  int64  `json:"notAfter"` // 毫秒
	Issuer    string `json:"issuer"`
	Error     string `json:"error,omitempty"`
	LastTry   int64  `json:"lastTry,omitempty"`
	NextRenew int64  `json:"nextRenew,omitempty"`
}

func subCertPaths(dataDir string) (cert, key, status string) {
	d := filepath.Join(dataDir, "subtls")
	return filepath.Join(d, "cert.pem"), filepath.Join(d, "key.pem"), filepath.Join(d, "status.json")
}

// ---------- 证书热加载 ----------

type certHolder struct {
	mu   sync.RWMutex
	cert *tls.Certificate
	leaf *x509.Certificate
}

func (h *certHolder) load(certFile, keyFile string) error {
	c, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return err
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.cert, h.leaf = &c, leaf
	h.mu.Unlock()
	return nil
}

func (h *certHolder) get() (*tls.Certificate, *x509.Certificate) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cert, h.leaf
}

// ---------- 同一个端口同时服务 HTTP 和 HTTPS ----------

type peekConn struct {
	net.Conn
	r io.Reader
}

func (c *peekConn) Read(p []byte) (int, error) { return c.r.Read(p) }

type dualListener struct {
	net.Listener
	tlsCfg *tls.Config
	ch     chan net.Conn
	done   chan struct{}
}

func newDualListener(l net.Listener, cfg *tls.Config) *dualListener {
	d := &dualListener{Listener: l, tlsCfg: cfg, ch: make(chan net.Conn, 64), done: make(chan struct{})}
	go d.loop()
	return d
}

func (d *dualListener) loop() {
	for {
		c, err := d.Listener.Accept()
		if err != nil {
			close(d.done)
			return
		}
		go func(c net.Conn) {
			// 看第一个字节：0x16 是 TLS 握手，其余当普通 HTTP
			c.SetReadDeadline(time.Now().Add(10 * time.Second))
			b := make([]byte, 1)
			if _, err := io.ReadFull(c, b); err != nil {
				c.Close()
				return
			}
			c.SetReadDeadline(time.Time{})
			pc := &peekConn{Conn: c, r: io.MultiReader(bytes.NewReader(b), c)}
			if b[0] == 0x16 && d.tlsCfg != nil {
				select {
				case d.ch <- tls.Server(pc, d.tlsCfg):
				case <-d.done:
					c.Close()
				}
				return
			}
			select {
			case d.ch <- pc:
			case <-d.done:
				c.Close()
			}
		}(c)
	}
}

func (d *dualListener) Accept() (net.Conn, error) {
	select {
	case c := <-d.ch:
		return c, nil
	case <-d.done:
		return nil, errors.New("listener closed")
	}
}

// ---------- 极简 ACME 客户端 ----------

type acmeClient struct {
	dir     map[string]any
	key     *ecdsa.PrivateKey
	kid     string
	nonce   string
	hc      *http.Client
	dirURL  string
	profile bool // 目录里有 shortlived 配置
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (c *acmeClient) jwk() map[string]string {
	pub := c.key.PublicKey
	pad := func(b *big.Int) []byte { out := make([]byte, 32); b.FillBytes(out); return out }
	return map[string]string{"crv": "P-256", "kty": "EC", "x": b64(pad(pub.X)), "y": b64(pad(pub.Y))}
}

func (c *acmeClient) thumbprint() string {
	j := c.jwk()
	s := fmt.Sprintf(`{"crv":"%s","kty":"%s","x":"%s","y":"%s"}`, j["crv"], j["kty"], j["x"], j["y"])
	h := sha256.Sum256([]byte(s))
	return b64(h[:])
}

func (c *acmeClient) url(name string) string { s, _ := c.dir[name].(string); return s }

func (c *acmeClient) getNonce() error {
	resp, err := c.hc.Head(c.url("newNonce"))
	if err != nil {
		return err
	}
	resp.Body.Close()
	c.nonce = resp.Header.Get("Replay-Nonce")
	if c.nonce == "" {
		return errors.New("ACME 服务没有返回 nonce")
	}
	return nil
}

// post 发一个签名请求；payload 为 nil 时是 POST-as-GET
func (c *acmeClient) post(url string, payload any) (*http.Response, []byte, error) {
	for attempt := 0; attempt < 3; attempt++ {
		if c.nonce == "" {
			if err := c.getNonce(); err != nil {
				return nil, nil, err
			}
		}
		prot := map[string]any{"alg": "ES256", "nonce": c.nonce, "url": url}
		if c.kid != "" {
			prot["kid"] = c.kid
		} else {
			prot["jwk"] = c.jwk()
		}
		pb, _ := json.Marshal(prot)
		pl := ""
		if payload != nil {
			b, _ := json.Marshal(payload)
			pl = b64(b)
		}
		signing := b64(pb) + "." + pl
		h := sha256.Sum256([]byte(signing))
		r, s, err := ecdsa.Sign(rand.Reader, c.key, h[:])
		if err != nil {
			return nil, nil, err
		}
		sig := make([]byte, 64)
		r.FillBytes(sig[:32])
		s.FillBytes(sig[32:])
		body, _ := json.Marshal(map[string]string{"protected": b64(pb), "payload": pl, "signature": b64(sig)})
		req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/jose+json")
		req.Header.Set("User-Agent", "nodedeck-agent")
		resp, err := c.hc.Do(req)
		if err != nil {
			return nil, nil, err
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		c.nonce = resp.Header.Get("Replay-Nonce")
		if resp.StatusCode == 400 && strings.Contains(string(data), "badNonce") {
			continue
		}
		if resp.StatusCode >= 400 {
			var p struct {
				Type   string `json:"type"`
				Detail string `json:"detail"`
			}
			json.Unmarshal(data, &p)
			if p.Detail == "" {
				p.Detail = strings.TrimSpace(string(data))
			}
			return resp, data, fmt.Errorf("ACME %d：%s", resp.StatusCode, p.Detail)
		}
		return resp, data, nil
	}
	return nil, nil, errors.New("ACME nonce 一直无效")
}

func newACME(cfg SubTLSCfg, dataDir string) (*acmeClient, error) {
	hc := &http.Client{Timeout: 30 * time.Second}
	if cfg.CAFile != "" {
		pemData, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM(pemData)
		hc.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
	}
	c := &acmeClient{hc: hc, dirURL: cfg.Directory}
	if c.dirURL == "" {
		c.dirURL = leDirectory
	}
	resp, err := hc.Get(c.dirURL)
	if err != nil {
		return nil, fmt.Errorf("连不上 ACME 服务：%v", err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(&c.dir); err != nil {
		return nil, fmt.Errorf("ACME 目录解析失败：%v", err)
	}
	if meta, ok := c.dir["meta"].(map[string]any); ok {
		if pr, ok := meta["profiles"].(map[string]any); ok {
			_, c.profile = pr["shortlived"]
		}
	}
	// 账户密钥：保存下来，续期时复用
	kf := filepath.Join(dataDir, "subtls", "account.key")
	if b, err := os.ReadFile(kf); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			if k, err := x509.ParseECPrivateKey(blk.Bytes); err == nil {
				c.key = k
			}
		}
	}
	if c.key == nil {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		der, _ := x509.MarshalECPrivateKey(k)
		os.MkdirAll(filepath.Dir(kf), 0700)
		os.WriteFile(kf, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0600)
		c.key = k
	}
	acct := map[string]any{"termsOfServiceAgreed": true}
	if cfg.Email != "" {
		acct["contact"] = []string{"mailto:" + cfg.Email}
	}
	resp2, _, err := c.post(c.url("newAccount"), acct)
	if err != nil {
		return nil, fmt.Errorf("注册 ACME 账户失败：%v", err)
	}
	c.kid = resp2.Header.Get("Location")
	return c, nil
}

func (c *acmeClient) poll(url string, want ...string) (map[string]any, error) {
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		_, data, err := c.post(url, nil)
		if err != nil {
			return nil, err
		}
		var m map[string]any
		json.Unmarshal(data, &m)
		st, _ := m["status"].(string)
		for _, w := range want {
			if st == w {
				return m, nil
			}
		}
		if st == "invalid" {
			detail := ""
			if chs, ok := m["challenges"].([]any); ok {
				for _, ch := range chs {
					if cm, ok := ch.(map[string]any); ok {
						if e, ok := cm["error"].(map[string]any); ok {
							detail, _ = e["detail"].(string)
						}
					}
				}
			}
			if e, ok := m["error"].(map[string]any); ok && detail == "" {
				detail, _ = e["detail"].(string)
			}
			return nil, fmt.Errorf("验证没通过：%s", detail)
		}
		time.Sleep(2 * time.Second)
	}
	return nil, errors.New("等待 ACME 结果超时")
}

// obtainCert 申请证书；成功后写入 cert.pem / key.pem
func obtainCert(cfg SubTLSCfg, dataDir string) error {
	host := strings.Trim(cfg.Host, "[]")
	if host == "" {
		return errors.New("没有设置 VPS 地址")
	}
	ip := net.ParseIP(host)
	if ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()) && (cfg.Directory == "" || cfg.Directory == leDirectory) {
		return fmt.Errorf("%s 是内网 / 本机地址，Let's Encrypt 不给这种地址签证书（服务器地址要填公网 IP）", host)
	}
	c, err := newACME(cfg, dataDir)
	if err != nil {
		return err
	}
	idType := "dns"
	if ip != nil {
		idType = "ip"
		if !c.profile && (cfg.Directory == "" || cfg.Directory == leDirectory) {
			return errors.New("Let's Encrypt 目前不提供 IP 证书的 shortlived 配置")
		}
	}
	order := map[string]any{"identifiers": []map[string]string{{"type": idType, "value": host}}}
	if ip != nil && c.profile {
		order["profile"] = "shortlived"
	}
	resp, data, err := c.post(c.url("newOrder"), order)
	if err != nil {
		return fmt.Errorf("创建证书订单失败：%v", err)
	}
	orderURL := resp.Header.Get("Location")
	var o map[string]any
	json.Unmarshal(data, &o)
	authzs, _ := o["authorizations"].([]any)
	// 临时在 80 端口回答验证文件
	tokens := map[string]string{}
	var tmu sync.Mutex
	port := cfg.HTTPPort
	if port == 0 {
		port = 80
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("80 端口被占用，没法完成证书验证（%v）。把占用 80 端口的程序停掉，或者用订阅域名", err)
	}
	srv := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t := strings.TrimPrefix(r.URL.Path, "/.well-known/acme-challenge/")
		tmu.Lock()
		ka, ok := tokens[t]
		tmu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, ka)
	})}
	go srv.Serve(ln)
	defer srv.Close()
	for _, au := range authzs {
		aURL, _ := au.(string)
		_, ad, err := c.post(aURL, nil)
		if err != nil {
			return err
		}
		var a map[string]any
		json.Unmarshal(ad, &a)
		if st, _ := a["status"].(string); st == "valid" {
			continue
		}
		var chURL, token string
		chs, _ := a["challenges"].([]any)
		for _, ch := range chs {
			cm, _ := ch.(map[string]any)
			if t, _ := cm["type"].(string); t == "http-01" {
				chURL, _ = cm["url"].(string)
				token, _ = cm["token"].(string)
			}
		}
		if chURL == "" {
			return errors.New("ACME 服务没有提供 http-01 验证")
		}
		tmu.Lock()
		tokens[token] = token + "." + c.thumbprint()
		tmu.Unlock()
		if _, _, err := c.post(chURL, map[string]any{}); err != nil {
			return err
		}
		if _, err := c.poll(aURL, "valid"); err != nil {
			if strings.Contains(err.Error(), "Timeout") || strings.Contains(err.Error(), "connection") || strings.Contains(err.Error(), "Fetching") {
				return fmt.Errorf("%v（Let's Encrypt 连不上这台 VPS 的 80 端口：检查服务商的安全组 / 防火墙是否放行 TCP 80）", err)
			}
			return err
		}
	}
	// 生成证书私钥和 CSR
	certKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	tpl := &x509.CertificateRequest{}
	if ip != nil {
		tpl.IPAddresses = []net.IP{ip}
	} else {
		tpl.DNSNames = []string{host}
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, tpl, certKey)
	if err != nil {
		return err
	}
	fin, _ := o["finalize"].(string)
	if _, _, err := c.post(fin, map[string]string{"csr": b64(csr)}); err != nil {
		return fmt.Errorf("签发失败：%v", err)
	}
	om, err := c.poll(orderURL, "valid")
	if err != nil {
		return err
	}
	certURL, _ := om["certificate"].(string)
	_, chain, err := c.post(certURL, nil)
	if err != nil {
		return err
	}
	if !bytes.Contains(chain, []byte("BEGIN CERTIFICATE")) {
		return errors.New("下载到的证书不对")
	}
	certFile, keyFile, _ := subCertPaths(dataDir)
	os.MkdirAll(filepath.Dir(certFile), 0700)
	der, _ := x509.MarshalECPrivateKey(certKey)
	if err := os.WriteFile(keyFile+".new", pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0600); err != nil {
		return err
	}
	if err := os.WriteFile(certFile+".new", chain, 0600); err != nil {
		return err
	}
	os.Rename(keyFile+".new", keyFile)
	return os.Rename(certFile+".new", certFile)
}

func readSubCertStatus(dataDir string) SubCertStatus {
	_, _, sf := subCertPaths(dataDir)
	var st SubCertStatus
	if b, err := os.ReadFile(sf); err == nil {
		json.Unmarshal(b, &st)
	}
	return st
}

func writeSubCertStatus(dataDir string, st SubCertStatus) {
	_, _, sf := subCertPaths(dataDir)
	os.MkdirAll(filepath.Dir(sf), 0700)
	b, _ := json.Marshal(st)
	os.WriteFile(sf, b, 0600)
}

// subCertLoop 检查证书，快到期（剩余不到一半，最少留 2 天）就续；失败按 1h、2h、4h…（最多 12h）重试
func (a *Agent) subCertLoop(h *certHolder) {
	cfg := a.cfg.SubTLS
	certFile, keyFile, _ := subCertPaths(a.cfg.DataDir)
	backoff := time.Hour
	for {
		_, leaf := h.get()
		need := leaf == nil
		if leaf != nil {
			life := leaf.NotAfter.Sub(leaf.NotBefore)
			need = time.Until(leaf.NotAfter) < life/2 || time.Until(leaf.NotAfter) < 48*time.Hour
			if hostOf(leaf) != strings.Trim(cfg.Host, "[]") {
				need = true // 换了 IP
			}
		}
		wait := 6 * time.Hour
		if need {
			st := SubCertStatus{Host: cfg.Host, LastTry: time.Now().UnixMilli()}
			err := obtainCert(*cfg, a.cfg.DataDir)
			if err == nil {
				err = h.load(certFile, keyFile)
			}
			if err != nil {
				log.Printf("订阅 HTTPS 证书申请失败：%v", err)
				st.Error = err.Error()
				if _, old := h.get(); old != nil && time.Now().Before(old.NotAfter) {
					st.OK, st.NotAfter, st.Issuer = true, old.NotAfter.UnixMilli(), old.Issuer.CommonName
				}
				wait = backoff
				if backoff < 12*time.Hour {
					backoff *= 2
				}
			} else {
				_, nl := h.get()
				st.OK, st.NotAfter, st.Issuer = true, nl.NotAfter.UnixMilli(), nl.Issuer.CommonName
				backoff = time.Hour
				log.Printf("订阅 HTTPS 证书已更新，有效期到 %s", nl.NotAfter.Format(time.RFC3339))
			}
			st.NextRenew = time.Now().Add(wait).UnixMilli()
			writeSubCertStatus(a.cfg.DataDir, st)
		}
		time.Sleep(wait)
	}
}

func hostOf(c *x509.Certificate) string {
	if len(c.IPAddresses) > 0 {
		return c.IPAddresses[0].String()
	}
	if len(c.DNSNames) > 0 {
		return c.DNSNames[0]
	}
	return ""
}

// subCertInfo 桌面端查询用：当前证书是否可用
func subCertInfo(dataDir string) SubCertStatus {
	st := readSubCertStatus(dataDir)
	certFile, keyFile, _ := subCertPaths(dataDir)
	var h certHolder
	if err := h.load(certFile, keyFile); err == nil {
		_, leaf := h.get()
		st.Host = hostOf(leaf)
		st.NotAfter = leaf.NotAfter.UnixMilli()
		st.Issuer = leaf.Issuer.CommonName
		st.OK = time.Now().Before(leaf.NotAfter)
	} else {
		st.OK = false
	}
	return st
}

var _ crypto.Signer = (*ecdsa.PrivateKey)(nil)
