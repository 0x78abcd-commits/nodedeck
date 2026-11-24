# NodeDeck 节点控制台

Windows 桌面软件：**填 VPS → 一键部署全套协议 → 分配给用户 → 用内置工具验证节点**。

| 模块 | 功能 |
|---|---|
| 服务器 | 批量操作；被墙巡检（只提醒或自动换新）；SSH 一键安装 sing-box + agent，自签或 Let's Encrypt 证书、BBR、防火墙放行；支持 Debian / Ubuntu / CentOS（systemd）和 Alpine（OpenRC），x86-64 / ARM64 / ARMv7 / x86；一键体检、被墙检测、一键换新；监控面板（CPU、内存、网速、三网延迟、本月流量、VPS 到期提醒） |
| 协议 | VLESS-Reality（部署时自动挑同网段邻居做目标，定期巡检自动换）、Trojan、VMess-WS、Hysteria2（混淆 + 端口跳跃）、TUIC v5、AnyTLS、Shadowsocks-2022；三种一键模板；IPv6 线路；Cloudflare 隧道（IP 被墙也能用，可配优选地址） |
| 路由 | 屏蔽 BT / 广告 / 回国流量，指定网站走 Cloudflare WARP |
| 节点 | 分享链接、二维码、本地测试（延迟 + 出口 IP + 是否机房 IP） |
| 用户 | 多用户、按线路分配、流量上限和定期重置、到期时间或首次使用后 N 天、在用状态、批量操作；订阅自动识别 v2rayN / Clash Meta / sing-box / Shadowrocket，浏览器打开是订阅信息页；临时订阅链接；自签证书自动带指纹（新版 v2rayNG 可直接用）；Telegram 通知和运维告警 |
| 落地 | 住宅 SOCKS5 / HTTP 或机场节点（链接 / 订阅导入）做出口，分组管理，一键切换 |
| 中转 / 隧道 | 用另一台 VPS 做端口转发；目标是节点协议时订阅里自动多一条「经中转」线路；也可以转发任意地址 |
| 网络优化 | 检测内核 / BBR / 队列 / 网卡，有依据地调整并可一键恢复；回程和去程线路识别（CN2 GIA、9929、CMI 等）；三网延迟、丢包、抖动和晚高峰对比；电脑到 VPS 的 TCP 测速和 UDP 丢包测试、Hysteria2 / TUIC 建议；BBR 和 CUBIC 对比；一键运行 NodeQuality、TcpQuality |
| 工具箱 | IP 画像、端口检测、DNS、路由追踪、被墙检测、Reality 目标检测和同网段扫描、SOCKS5 转二维码 |
| 更新 | 软件自动更新；VPS 上的 sing-box 内核由 agent 每天检查、校验后自动升级（失败自动回滚），可限定升级时间段 |

软件本身不改系统代理、不装虚拟网卡、不需要管理员权限。

## 工作原理

```
Windows 上的 NodeDeck ──SSH──▶ VPS
                              ├─ nodedeck-sing-box（带 with_v2ray_api 的 sing-box，按用户统计流量，自动升级）
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
   - 另外还有一个名为 `singbox` 的预发布 Release：VPS 部署和自动升级用的 sing-box 内核，请勿删除

仓库地址和版本号由 CI 自动写进软件，`package.json` 不用手动改。

## 以后发布更新

改完代码推到 GitHub，然后 **Actions → Release → Run workflow**，填一个更大的版本号（如 `0.1.1`）。
用户那边的安装版会在 30 分钟内收到更新提示，点一下就更新完成。

也可以用 tag 发布：`git tag v0.1.1 && git push --tags`。

> 国内网络访问 GitHub 不稳定，检查和下载更新需要先打开代理软件（V2rayN / Clash 等）。

## 自动更新一览

| 什么 | 怎么更新 | 要不要你动手 |
|---|---|---|
| sing-box 内核（协议） | `sing-box 内核` 工作流每天检查官方最新正式版，自动编译发布到名为 `singbox` 的 Release；每台 VPS 的 agent 每 6 小时检查一次并升级 | 不用 |
| VPS 上的 agent | 软件更新后，在「服务器」点「同步全部」就会顺带升级（顶部会提示） | 点一下 |
| 桌面软件 | 你在 Actions 里运行 Release 发版，用户端自动提示更新 | 只有改了代码才需要 |
| 新协议 / 新功能 | 需要改代码 | 需要 |

内核升级的安全措施：sha256 校验 → 新版必须能通过当前配置的 `check` → 重启后 4 秒内没起来就自动回滚到旧版。
升级失败不会影响正在运行的节点，原因会显示在 agent 的状态里。也可以在「服务器」页点「升级内核」立即检查。
不想自动升级的话，在「设置」里关掉，然后点「同步全部」。

> GitHub 规定：仓库连续 60 天没有任何提交，定时工作流会被自动暂停（会给你发邮件）。到 Actions 页面点一下 Enable 就能恢复，或者随便提交一次代码。

## 跟进参考仓库

- `参考仓库更新提醒` 工作流每周检查 [Teminuosi/tms-client](https://github.com/Teminuosi/tms-client/releases) 的新版本，有新版就在本仓库开一个带 `upstream-tms` 标签的 Issue，列出它的更新说明。
- Claude 的每周定时任务会读这些更新说明，判断哪些值得加，自己实现后提交 Pull Request，你审核合并后再发版。
- 参考仓库不公开源码，所以只参考它的功能描述，自己实现，不复制它的代码或安装包。
- 已处理过的版本记录在 `docs/upstream-tracking.md`。

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
src/main/deploy.js    SSH 部署、同步（含 agent 升级）、状态、卸载
src/main/tools.js     工具箱
src/main/nodetest.js  本地 sing-box 节点测试
src/main/updater.js   自动更新
src/main/store.js     本地数据（Windows DPAPI 加密）
src/renderer/         界面（原生 JS，无需构建）
agent/                VPS 端 agent（Go，仅标准库；update.go 是内核自动升级）
.github/workflows/    release.yml 发布软件；singbox.yml 每天自动构建 sing-box 内核；upstream-watch.yml 每周提醒参考仓库更新
```

## 注意

- exe 没有代码签名，第一次运行 Windows SmartScreen 可能拦截，点「更多信息 → 仍要运行」。
- Trojan / Hysteria2 / TUIC / AnyTLS 用的是自签证书，客户端链接里已经带了「跳过证书验证」。
- sing-box 以 GPL-3.0 许可证发布，作为独立程序随附，未做修改。
