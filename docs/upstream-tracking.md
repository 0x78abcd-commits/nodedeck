# 上游跟进

## 跟踪清单

`.github/workflows/upstream-watch.yml` 每周一检查下面这些仓库的正式版，有新版就开 Issue（标签 `upstream-*`）。

| 优先级 | 仓库 | 跟什么 | 为什么 |
|---|---|---|---|
| P0 | SagerNet/sing-box | Release、配置字段、弃用项 | 唯一内核，协议和配置格式以它为准 |
| P0 | XTLS/Xray-core | Reality / Vision / 新传输 | Reality 的源头，抗封锁思路常先出现在这里（只借鉴，不换内核） |
| P1 | apernet/hysteria | Hysteria2 规范、URI 参数 | 分享链接要跟上（如 pinSHA256） |
| P1 | tuic-protocol/tuic | TUIC v5 变更 | 已支持 TUIC |
| P1 | 2dust/v2rayNG、2dust/v2rayN | 客户端兼容、导入问题 | 用户最多，链接必须能导入（例：2026-08 起移除 allowInsecure，自签证书要带证书指纹） |
| P2 | MetaCubeX/mihomo | Clash 订阅字段 | 已出 Clash 订阅 |

## 自动化与原则

- **内核可以自动升**：`singbox.yml` 每天构建 sing-box 最新正式版；发布前用新内核跑 `test/run.js`，NodeDeck 生成的所有配置都要通过 `sing-box check` 才发布。VPS 上的 agent 升级前还会用新内核校验本机的 config.json / config.full.json / cf.json，不通过就跳过，启动失败自动回滚。
- **协议字段 / 配置变更要人工确认、测试通过后再合入**：Issue 里看到新字段或弃用项，改 `src/main/core.js` 并补测试。
- **分享链接回归**：`test/run.js` 固定几条标准节点（特殊字符密码、IPv6、自签证书指纹、端口跳跃），用 Node 的 URL 和 `java.net.URI`（v2rayNG 的解析方式）各解析一遍。
- **只用 sing-box 一个内核**，不切 Xray；不引入第三方面板脚本依赖。

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
