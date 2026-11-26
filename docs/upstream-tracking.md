# 上游跟进

## 跟踪清单

`.github/workflows/upstream-watch.yml` 每周一检查下面这些仓库，有新版本（脚本类仓库看新提交）就开 Issue（标签 `upstream-*`）。

| 优先级 | 仓库 | 跟什么 | 为什么 |
|---|---|---|---|
| P0 | SagerNet/sing-box | Release、配置字段、弃用项 | 唯一内核，协议和配置格式以它为准 |
| P0 | XTLS/Xray-core | Release、XHTTP 参数、弃用项 | VLESS-XHTTP-Reality / VLESS-XHTTP-TLS 用 Xray 内核跑；Reality 的源头 |
| P1 | apernet/hysteria | Hysteria2 规范、URI 参数 | 分享链接要跟上（如 pinSHA256） |
| P1 | tuic-protocol/tuic | TUIC v5 变更 | 已支持 TUIC |
| P1 | 2dust/v2rayNG、2dust/v2rayN | 客户端兼容、导入问题 | 用户最多，链接必须能导入（例：2026-08 起移除 allowInsecure，自签证书要带证书指纹） |
| P1 | cloudflare/cloudflared | Release、隧道协议、弃用通知 | Cloudflare 隧道用 sing-box 内置的 cloudflared，官方协议变化会影响连接 |
| P1 | LloydAsp/NodeQuality | 主分支提交 | 社区测试直接运行它的脚本，交互选项、报告链接格式变了要跟着改 |
| P1 | ibsgss/TcpQuality | 主分支提交 | 同上 |
| P2 | MetaCubeX/mihomo | Clash 订阅字段 | 已出 Clash 订阅 |
| P2 | ClickDevTech/CELERITY-panel | Tag | 同类面板（MIT）：Xray XHTTP、级联中转、负载均衡、外部探针 |
| P2 | nezhahq/nezha | Release | 探针参考：服务器卡片、流量 / 到期展示、告警（只参考做法；NodeDeck 探针只读，不做远程命令） |
| P2 | henrygd/beszel | Release | 探针参考（MIT）：轻量采集、历史曲线、告警阈值和通知渠道 |
| P1 | dgtlmoon/changedetection.io | Release | 补货提醒一键安装的就是它：镜像名、浏览器容器、补货检测设置变了要跟着改 |
| P2 | Teminuosi/tms-client | Release（含预发布） | 同类桌面工具：功能灵感（不公开源码，只看更新说明，自己实现；不解包安装包）。11-25 停过一次，当天恢复 |

不跟踪的（2026-11-25 评估）：

- MetaCubeX/meta-rules-dat：规则数据每天自动发布，跟踪只会刷屏；NodeDeck 用的是 SagerNet 的 sing-geosite / sing-geoip 规则集，sing-box 自己每 7 天更新一次
- acmesh-official/acme.sh：NodeDeck 不用它，域名证书由 sing-box 内置 ACME 申请，订阅的 IP 证书由 agent 自己申请
- docker/compose：只在「清理其他程序」的一键恢复里用到 `docker compose up -d`，接口很稳定
- prometheus/prometheus：NodeDeck 的监控由 agent 采集、桌面端画图，不打算引入 Prometheus
- xykt/NetQuality：NodeQuality 的「网络质量」一项就是直接调用它的脚本（Net.Check.Place），社区测试里已经包含；它的变化会通过 NodeQuality 体现，单独跟踪重复
- acidmiku/z_panel：星数很少、没有开源许可证，参考价值不大（2026-11-25 取消）

## 自动化与原则

- **内核可以自动升**：`singbox.yml` 每天构建 sing-box 最新正式版；发布前用新内核跑 `test/run.js`，NodeDeck 生成的所有配置都要通过 `sing-box check` 才发布。VPS 上的 agent 升级前还会用新内核校验本机的 config.json / config.full.json / cf.json，不通过就跳过，启动失败自动回滚。
- **协议字段 / 配置变更要人工确认、测试通过后再合入**：Issue 里看到新字段或弃用项，改 `src/main/core.js` 并补测试。
- **分享链接回归**：`test/run.js` 固定几条标准节点（特殊字符密码、IPv6、自签证书指纹、端口跳跃），用 Node 的 URL 和 `java.net.URI`（v2rayNG 的解析方式）各解析一遍。
- **主内核是 sing-box**；只有 XHTTP 两个协议（VLESS-XHTTP-Reality / VLESS-XHTTP-TLS）用 Xray，没开就不装。Xray 收到的流量经本机 socks 交给 sing-box，路由、落地、WARP 只在 sing-box 里配一份。`xray.yml` 每天同步官方 Release（校验官方 SHA2-256），发布前用新 Xray 跑 `test/run.js`。不引入第三方面板脚本依赖。

---

# 参考仓库跟进记录

参考仓库：https://github.com/Teminuosi/tms-client （只发布安装包，不公开源码）

> 2026-11-25 起停止跟踪：工作流和每周定时任务都已取消，下面是停止前的记录。

NodeDeck 0.1.0 按参考仓库 README 的功能表实现（截至 2026-11-20，对方最新版 0.1.69）。
之后每处理一个版本，在下面加一行：版本、处理日期、结论（已实现 / 已有 / 不适用 / 暂缓）和对应的 PR。

| 参考版本 | 处理日期 | 结论 | PR |
|---|---|---|---|
| ≤ 0.1.69 | 2026-11-20 | 按 README 功能表完成初版 | — |
| 0.1.20–0.1.39、0.1.50–0.1.79 | 2026-11-21 | 已逐条核对，待做事项整理进 docs/roadmap.md | — |
| 0.1.40–0.1.49 | 2026-11-21 | 未读到（GitHub 限流），下次跟进时补读 | — |
