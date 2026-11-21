package main

// Cloudflare WARP 免费账号注册（与 wgcf 等工具相同的公开接口），生成 WireGuard 参数
import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

type WarpAccount struct {
	PrivateKey    string `json:"privateKey"`
	PeerPublicKey string `json:"peerPublicKey"`
	Address4      string `json:"address4"`
	Address6      string `json:"address6"`
	Reserved      []int  `json:"reserved"`
	EndpointHost  string `json:"endpointHost"`
	EndpointPort  int    `json:"endpointPort"`
	ID            string `json:"id"`
	Token         string `json:"token"`
}

const warpAPI = "https://api.cloudflareclient.com/v0a2158/reg"

func warpRegister(apiURL string) (*WarpAccount, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]any{
		"key":           base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes()),
		"install_id":    "",
		"fcm_token":     "",
		"tos":           time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"model":         "PC",
		"serial_number": "",
		"locale":        "en_US",
	})
	req, _ := http.NewRequest("POST", apiURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	req.Header.Set("User-Agent", "okhttp/3.12.1")
	req.Header.Set("CF-Client-Version", "a-6.10-2158")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接 Cloudflare 失败: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Cloudflare 返回 HTTP %d: %s", resp.StatusCode, string(raw))
	}
	var r struct {
		ID     string `json:"id"`
		Token  string `json:"token"`
		Config struct {
			ClientID string `json:"client_id"`
			Peers    []struct {
				PublicKey string `json:"public_key"`
				Endpoint  struct {
					V4   string `json:"v4"`
					Host string `json:"host"`
				} `json:"endpoint"`
			} `json:"peers"`
			Interface struct {
				Addresses struct {
					V4 string `json:"v4"`
					V6 string `json:"v6"`
				} `json:"addresses"`
			} `json:"interface"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("解析 Cloudflare 响应失败: %w", err)
	}
	if len(r.Config.Peers) == 0 || r.Config.Interface.Addresses.V4 == "" {
		return nil, fmt.Errorf("Cloudflare 响应缺少 WireGuard 参数")
	}
	acc := &WarpAccount{
		PrivateKey:    base64.StdEncoding.EncodeToString(priv.Bytes()),
		PeerPublicKey: r.Config.Peers[0].PublicKey,
		Address4:      r.Config.Interface.Addresses.V4,
		Address6:      r.Config.Interface.Addresses.V6,
		Reserved:      []int{0, 0, 0},
		EndpointHost:  "162.159.192.1",
		EndpointPort:  2408,
		ID:            r.ID,
		Token:         r.Token,
	}
	// client_id 是 3 字节的 reserved 字段，部分地区需要它才能连上
	if b, err := base64.StdEncoding.DecodeString(r.Config.ClientID); err == nil && len(b) == 3 {
		acc.Reserved = []int{int(b[0]), int(b[1]), int(b[2])}
	}
	// 用接口返回的 v4 端点（形如 162.159.192.1:0），端口固定用 2408
	if host, _, err := net.SplitHostPort(r.Config.Peers[0].Endpoint.V4); err == nil && net.ParseIP(host) != nil {
		acc.EndpointHost = host
	}
	return acc, nil
}

// warpRegisterCmd: 已存在则直接输出，-force 时重新注册
func warpRegisterCmd(out string, force bool, apiURL string) {
	if !force {
		if b, err := os.ReadFile(out); err == nil {
			os.Stdout.Write(b)
			return
		}
	}
	acc, err := warpRegister(apiURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "注册 WARP 失败:", err)
		os.Exit(1)
	}
	b, _ := json.MarshalIndent(acc, "", "  ")
	if err := writeFileAtomic(out, b, 0600); err != nil {
		fmt.Fprintln(os.Stderr, "保存失败:", err)
		os.Exit(1)
	}
	os.Stdout.Write(b)
}
