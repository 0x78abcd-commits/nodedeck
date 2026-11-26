# NodeDeck 节点控制台

Windows 桌面软件：**填 VPS → 一键部署全套协议 → 分配给用户 → 用内置工具验证节点**。

| 模块 | 功能 |
|---|---|
| 服务器 | 批量操作；被墙巡检（默认关，可开成只提醒或自动换新）；SSH 一键安装 sing-box + agent，自签或 Let's Encrypt 证书、BBR、防火墙放行；支持 Debian / Ubuntu / CentOS（systemd）和 Alpine（OpenRC），x86-64 / ARM64 / ARMv7 / x86；一键体检、被墙检测、一键换新；监控面板（CPU、内存、网速、三网延迟、本月流量、VPS 到期提醒） |
| 协议 | VLESS-Reality（部署时自动挑同网段邻居做目标，定期巡检自动换）、Trojan、VMess-WS、Hysteria2（混淆 + 端口跳跃）、TUIC v5、AnyTLS、Shadowsocks-2022、VLESS-XHTTP-Reality / VLESS-XHTTP-TLS（Xray 内核，开了才装）；三种一键模板；IPv6 线路；Cloudflare 隧道（IP 被墙也能用，可配优选地址） |
| 路由 | 屏蔽 BT / 广告 / 回国流量，指定网站走 Cloudflare WARP |
| 节点 | 分享链接、二维码、本地测试（延迟 + 出口 IP，出口由节点所在 VPS 自己报，不经第三方）；每台服务器一键体检 / 一键测延迟 / 一键测速（经节点下载测速）；节点改名 |
| 用户 | 多用户、按线路分配、流量上限和定期重置、到期时间或首次使用后 N 天、在用设备数（最近 10 分钟的来源 IP）、批量操作；订阅自动识别 v2rayN / Clash Meta / sing-box / Shadowrocket，浏览器打开是订阅信息页；临时订阅链接；自签证书自动带指纹（新版 v2rayNG 可直接用）；Telegram / 微信（PushPlus、Server 酱）通知和运维告警 |
| 落地 | 住宅 SOCKS5 / HTTP 或机场节点（链接 / 订阅导入）做出口，分组管理，一键切换 |
| 中转 | 用一台国内直连好的 VPS 转发到节点，用户订阅里自动多一条「经中转」线路；一次勾多个协议，入口端口自动分配；显示中转机到节点通不通、延迟、流量和连接数 |
| 端口转发 | 在 VPS 上把 TCP / UDP 端口转到任意地址：多个目标主备 / 轮询、目标探测、按规则统计流量和连接数、来源 IP 白名单、批量添加。中转和端口转发都由中转机上的 agent 做 |
| 网络优化 | 检测内核 / BBR / 队列 / 网卡，有依据地调整并可一键恢复；回程和去程线路识别（CN2 GIA、9929、CMI 等）；三网延迟、丢包、抖动和晚高峰对比；电脑到 VPS 的 TCP 测速和 UDP 丢包测试、Hysteria2 / TUIC 建议；BBR 和 CUBIC 对比；一键运行 NodeQuality、TcpQuality |
| 工具箱 | IP 画像、端口检测、DNS、路由追踪、被墙检测、Reality 目标检测和同网段扫描、SOCKS5 转二维码 |
| 更新 | 软件自动更新；VPS 上的 sing-box 内核由 agent 每天检查、校验后自动升级（失败自动回滚），可限定升级时间段 |

软件本身不改系统代理、不装虚拟网卡、不需要管理员权限。

## 探针网页

「设置 → 探针网页」里选一台服务器当主控：它每 5 秒从各台 VPS 的 agent 读一次 CPU、内存、磁盘、网速、本月流量（只读接口，带密钥），在订阅端口上出一个网页 `https://IP:订阅端口/p/<随机口令>/`，手机浏览器就能看。某台 1 分钟没回应会发通知（Telegram / 微信），恢复后再发一次。网页里不显示 IP，没有任何远程操作功能。

## 补货提醒

「补货提醒」页面有两种方式：内置提醒（agent 定时打开商品页按文字判断，变了发通知，不用装东西）和一键安装 changedetection.io（Docker 精简模式，约 100MB 内存；可带 Chrome 看 JavaScript 页面；只监听 VPS 本机，经 SSH 隧道打开管理界面）。

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
| Xray 内核（XHTTP 协议） | `Xray 内核` 工作流每天从官方 Release 同步（校验官方 SHA2-256）到名为 `xray` 的 Release；开了 XHTTP 的 VPS 跟 sing-box 一起自动升级 | 不用 |
| VPS 上的 agent | 软件更新后，在「服务器」点「同步全部」就会顺带升级（顶部会提示） | 点一下 |
| 桌面软件 | 你在 Actions 里运行 Release 发版，用户端自动提示更新 | 只有改了代码才需要 |
| 新协议 / 新功能 | 需要改代码 | 需要 |

内核升级的安全措施：sha256 校验 → 新版必须能通过当前配置的 `check` → 重启后 4 秒内没起来就自动回滚到旧版。
升级失败不会影响正在运行的节点，原因会显示在 agent 的状态里。也可以在「服务器」页点「升级内核」立即检查。
不想自动升级的话，在「设置」里关掉，然后点「同步全部」。

> GitHub 规定：仓库连续 60 天没有任何提交，定时工作流会被自动暂停（会给你发邮件）。到 Actions 页面点一下 Enable 就能恢复，或者随便提交一次代码。

## 跟进参考仓库

`上游仓库更新提醒` 工作流每周检查 sing-box、Xray、Hysteria、TUIC、cloudflared、v2rayN / v2rayNG、mihomo、NodeQuality、TcpQuality、CELERITY-panel 和 Teminuosi/tms-client 的新版本，有更新就开 Issue。TMS 不公开源码，只看它的更新说明，自己实现。清单和理由见 `docs/upstream-tracking.md`。

## 测试

- `node test/run.js`：生成的各种配置都能被 sing-box / Xray 读进去（`SINGBOX=…`、`XRAY=…` 指定内核）
- `node test/e2e.js`：真流量测试，本机起全协议服务端，用 sing-box / Xray / mihomo 三种客户端逐个连（`SINGBOX=… XRAY=… MIHOMO=…`）
- `cd agent && go test ./...`：agent 单元测试

GitHub 上每次推送、发版、内核自动同步前都会跑（`.github/workflows/test.yml`）。

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
src/main/core.js      协议、用户、sing-box / Xray 服务端配置、端口分配（纯逻辑，可单测）
src/main/subscribe.js 节点入口、分享链接、订阅（v2rayN / Clash / sing-box）、客户端出站
src/main/deploy.js    SSH 部署、同步（含 agent 升级）、状态、卸载
src/main/units.js     VPS 上的路径和服务文件（systemd / OpenRC）
src/main/bench.js     网络优化、社区测试脚本
src/main/cleanup.js   清理其他面板 / 程序、备份和恢复
src/main/probe.js     探针网页（主控、密钥、机器列表）
src/main/stock.js     补货提醒（内置规则、changedetection.io 安装 / 隧道 / 卸载）
src/main/tools.js     工具箱
src/main/nodetest.js  本地节点测试（sing-box / Xray）
src/main/updater.js   自动更新
src/main/store.js     本地数据（Windows DPAPI 加密）
src/renderer/         界面（原生 JS，无需构建；按页面分文件，index.html 按顺序加载，settings.js 最后启动界面）
agent/                VPS 端 agent（Go，仅标准库；update.go 内核自动升级，xray.go Xray，probe.go 探针，stock.go 补货提醒）
test/                 run.js 配置检查；e2e.js 真流量测试
.github/workflows/    release.yml 发布软件；test.yml 测试；singbox.yml / xray.yml 每天同步内核；upstream-watch.yml 每周提醒上游更新
```

## 注意

- exe 没有代码签名，第一次运行 Windows SmartScreen 可能拦截，点「更多信息 → 仍要运行」。
- Trojan / Hysteria2 / TUIC / AnyTLS 用的是自签证书，客户端链接里已经带了「跳过证书验证」。
- sing-box 以 GPL-3.0 许可证发布，作为独立程序随附，未做修改。
- 端口转发的多目标主备 / 轮询、目标探测、按规则统计参考 [realm](https://github.com/zhboner/realm) 和 [gost](https://github.com/go-gost/gost) 这类转发工具（只参考做法，代码是自己写的）；节点测速参考 v2rayN / subs-check 的做法（真连接延迟请求 generate_204，经节点下载测速）。
- 回程线路判断（各骨干网的地址段和按先后顺序判断的规则）参考 [oneclickvirt/backtrace](https://github.com/oneclickvirt/backtrace)（Apache-2.0）；在用设备统计的做法参考 3x-ui 的 IP 限制（读代理内核的连接日志）。
