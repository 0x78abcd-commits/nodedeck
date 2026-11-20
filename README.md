# NodeDeck 节点控制台

Windows 桌面软件：**填 VPS → 一键部署全套协议 → 分配给用户 → 用内置工具验证节点**。

| 模块 | 功能 |
|---|---|
| 服务器 | SSH 一键安装 sing-box + agent，自签证书、BBR、防火墙放行、systemd 守护；查看状态 / 日志 / 卸载 |
| 协议 | VLESS-Reality、Trojan、VMess-WS、Hysteria2、TUIC v5、AnyTLS，每个可单独开关和改端口 |
| 节点 | 分享链接、二维码、本地测试（延迟 + 出口 IP + 是否机房 IP） |
| 用户 | 多用户、按线路分配、流量上限、到期时间、订阅地址（v2rayN base64 / Clash Meta 自动识别）、重置流量 |
| 落地 | 住宅 IP 等 SOCKS5 / HTTP 落地，服务器出口一键切换，测试落地出口 IP |
| 中转 / 隧道 | 用另一台 VPS 做端口转发；目标是节点协议时订阅里自动多一条「经中转」线路；也可以转发任意地址 |
| 工具箱 | IP 画像、端口检测、DNS、路由追踪、Reality 目标域名检测（本机 + 服务器）、SOCKS5 转二维码 |
| 更新 | 安装版启动 10 秒后检查，之后每 30 分钟检查一次，点「立即更新」自动下载并重启；便携版提示下载新包 |

软件本身不改系统代理、不装虚拟网卡、不需要管理员权限。

## 工作原理

```
Windows 上的 NodeDeck ──SSH──▶ VPS
                              ├─ nodedeck-sing-box（带 with_v2ray_api 的 sing-box，按用户统计流量）
                              └─ nodedeck-agent（Go，本仓库 agent/）
                                   ├─ 每 5 秒读取各用户流量，保存在 /etc/nodedeck/traffic.json
                                   ├─ 超额 / 到期 / 停用的用户自动移出配置并热重载
                                   └─ :2096/sub/<token> 提供订阅（带 subscription-userinfo 用量头）
```

流量统计和停用都在 VPS 上执行，所以电脑关机也照样生效。

## 第一次发布（只需要做一次）

1. 在 GitHub 新建一个 **公开** 仓库（例如 `nodedeck`）。自动更新要从 Release 下载，私有仓库下载不了。
2. 把本项目推上去：
   ```bash
   git remote add origin https://github.com/你的用户名/nodedeck.git
   git push -u origin main
   ```
3. 打开仓库的 **Actions → Release → Run workflow**，版本号填 `0.1.0`，点运行。
4. 大约 10 分钟后，**Releases** 里会出现：
   - `NodeDeck-Setup-0.1.0.exe`：安装版，支持自动更新
   - `NodeDeck-0.1.0-portable.exe`：便携版
   - `nodedeck-sing-box-linux-amd64.gz` / `arm64.gz`：部署时 VPS 会从这里下载

仓库地址和版本号由 CI 自动写进软件，`package.json` 不用手动改。

## 以后发布更新

改完代码推到 GitHub，然后 **Actions → Release → Run workflow**，填一个更大的版本号（如 `0.1.1`）。
用户那边的安装版会在 30 分钟内收到更新提示，点一下就更新完成。

也可以用 tag 发布：`git tag v0.1.1 && git push --tags`。

> 国内网络访问 GitHub 不稳定，检查和下载更新需要先打开代理软件（V2rayN / Clash 等）。

## 本地开发

```bash
npm install
bash scripts/build-agent.sh      # 需要 Go，编译 agent 到 resources/agent
# 把 sing-box.exe 放到 resources/bin/（节点测试用，从 sing-box 官方 Release 下载 windows-amd64）
npm start                        # 开发模式运行
npm run dist                     # 打包 exe 到 dist/（在 Windows 上运行）
```

用真实 sing-box 校验生成的配置：`SINGBOX=path/to/sing-box npm test`

## 目录

```
src/main/core.js      配置生成 / 分享链接 / 订阅（纯逻辑，可单测）
src/main/deploy.js    SSH 部署、同步、状态、卸载
src/main/tools.js     工具箱
src/main/nodetest.js  本地 sing-box 节点测试
src/main/updater.js   自动更新
src/main/store.js     本地数据（Windows DPAPI 加密）
src/renderer/         界面（原生 JS，无需构建）
agent/                VPS 端 agent（Go，仅标准库）
.github/workflows/    自动构建发布
```

## 注意

- exe 没有代码签名，第一次运行 Windows SmartScreen 可能拦截，点「更多信息 → 仍要运行」。
- Trojan / Hysteria2 / TUIC / AnyTLS 用的是自签证书，客户端链接里已经带了「跳过证书验证」。
- sing-box 以 GPL-3.0 许可证发布，作为独立程序随附，未做修改。
