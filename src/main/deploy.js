'use strict';
// 通过 SSH 在 VPS 上安装 / 同步 / 卸载 NodeDeck（sing-box + agent）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');
const tools = require('./tools');
const { withSSH, shq } = require('./ssh');
const QRCode = require('qrcode');

const DIR = core.REMOTE_DIR;
const SB_BIN = '/usr/local/bin/nodedeck-sing-box';
const AGENT_BIN = '/usr/local/bin/nodedeck-agent';

// 小内存机器的内存上限（Go 运行时的 GOMEMLIMIT）：流量高峰过后把多占的内存还给系统。
// 实测 sing-box 空闲约 40MB，每个正在传数据的连接约 0.5–0.8MB；agent 约 10MB。
// 2GB 以上的机器不设，按 Go 默认行为
function memLimits(memMB) {
  if (!memMB || memMB > 2048) return { sb: '', agent: '' };
  return { sb: `${Math.max(128, Math.floor(memMB * 0.5))}MiB`, agent: '48MiB' };
}

function sbUnit(lim = {}) {
  return `[Unit]
Description=NodeDeck sing-box
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${SB_BIN} run -c ${DIR}/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=3
LimitNOFILE=1048576
${lim.sb ? `Environment=GOMEMLIMIT=${lim.sb}
` : ''}# 被扫描时错误日志会很多，限速避免把日志盘写满
LogRateLimitIntervalSec=30s
LogRateLimitBurst=300

[Install]
WantedBy=multi-user.target
`;
}

function agentUnit(lim = {}) {
  return `[Unit]
Description=NodeDeck agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${AGENT_BIN} run -c ${DIR}/agent.json
Restart=always
RestartSec=3
${lim.agent ? `Environment=GOMEMLIMIT=${lim.agent}
` : ''}LogRateLimitIntervalSec=30s
LogRateLimitBurst=100

[Install]
WantedBy=multi-user.target
`;
}

const openrcSb = (lim = {}) => `#!/sbin/openrc-run
${lim.sb ? `export GOMEMLIMIT=${lim.sb}
` : ''}name="nodedeck-singbox"
description="NodeDeck sing-box"
command="${SB_BIN}"
command_args="run -c ${DIR}/config.json"
supervisor="supervise-daemon"
respawn_delay=3
respawn_max=0
output_log="/var/log/nodedeck-singbox.log"
error_log="/var/log/nodedeck-singbox.log"
rc_ulimit="-n 1048576"
extra_started_commands="reload"
depend() { need net; after firewall; }
reload() { ebegin "Reloading \$RC_SVCNAME"; supervise-daemon "\$RC_SVCNAME" --signal HUP; eend \$?; }
`;

const CF_UNIT = `[Unit]
Description=NodeDeck Cloudflare tunnel
After=network-online.target nodedeck-singbox.service
Wants=network-online.target

[Service]
ExecStart=${SB_BIN} run -c ${DIR}/cf.json
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
`;

const OPENRC_CF = `#!/sbin/openrc-run
name="nodedeck-cf"
description="NodeDeck Cloudflare tunnel"
command="${SB_BIN}"
command_args="run -c ${DIR}/cf.json"
supervisor="supervise-daemon"
respawn_delay=15
respawn_max=0
output_log="/var/log/nodedeck-cf.log"
error_log="/var/log/nodedeck-cf.log"
depend() { need net; after nodedeck-singbox; }
`;

const openrcAgent = (lim = {}) => `#!/sbin/openrc-run
${lim.agent ? `export GOMEMLIMIT=${lim.agent}\n` : ''}name="nodedeck-agent"
description="NodeDeck agent"
command="${AGENT_BIN}"
command_args="run -c ${DIR}/agent.json"
supervisor="supervise-daemon"
respawn_delay=3
respawn_max=0
output_log="/var/log/nodedeck-agent.log"
error_log="/var/log/nodedeck-agent.log"
depend() { need net; after firewall; }
`;

// 不同 init 系统下的服务命令
const SVC = {
  systemd: {
    install: 'systemctl daemon-reload && systemctl enable nodedeck-singbox nodedeck-agent >/dev/null 2>&1',
    restartAgent: 'systemctl restart nodedeck-agent',
    restartSb: 'systemctl restart nodedeck-singbox',
    active: (n) => `systemctl is-active ${n} 2>/dev/null`,
    logs: 'journalctl -u nodedeck-singbox -u nodedeck-agent -u nodedeck-cf -n 120 --no-pager',
    cfOn: (unit) => `cat > /etc/systemd/system/nodedeck-cf.service <<'NDEOF'\n${unit}NDEOF\nsystemctl daemon-reload && systemctl enable nodedeck-cf >/dev/null 2>&1; systemctl restart nodedeck-cf`,
    cfOff: 'if [ -f /etc/systemd/system/nodedeck-cf.service ]; then systemctl disable --now nodedeck-cf >/dev/null 2>&1; rm -f /etc/systemd/system/nodedeck-cf.service; systemctl daemon-reload; fi; true',
    remove: `systemctl disable --now nodedeck-agent nodedeck-singbox nodedeck-cf >/dev/null 2>&1 || true
rm -f /etc/systemd/system/nodedeck-agent.service /etc/systemd/system/nodedeck-singbox.service /etc/systemd/system/nodedeck-cf.service
systemctl daemon-reload`,
  },
  openrc: {
    install: 'rc-update add nodedeck-singbox default >/dev/null 2>&1; rc-update add nodedeck-agent default >/dev/null 2>&1; true',
    restartAgent: 'rc-service nodedeck-agent restart',
    restartSb: 'rc-service nodedeck-singbox restart',
    active: (n) => `rc-service ${n} status >/dev/null 2>&1 && echo active || echo inactive`,
    logs: 'tail -n 60 /var/log/nodedeck-singbox.log /var/log/nodedeck-agent.log /var/log/nodedeck-cf.log 2>/dev/null',
    cfOn: () => `cat > /etc/init.d/nodedeck-cf <<'NDEOF'\n${OPENRC_CF}NDEOF\nchmod 755 /etc/init.d/nodedeck-cf; rc-update add nodedeck-cf default >/dev/null 2>&1; rc-service nodedeck-cf restart`,
    cfOff: 'if [ -f /etc/init.d/nodedeck-cf ]; then rc-service nodedeck-cf stop >/dev/null 2>&1; rc-update del nodedeck-cf default >/dev/null 2>&1; rm -f /etc/init.d/nodedeck-cf; fi; true',
    remove: `rc-service nodedeck-agent stop >/dev/null 2>&1; rc-service nodedeck-singbox stop >/dev/null 2>&1; rc-service nodedeck-cf stop >/dev/null 2>&1
rc-update del nodedeck-agent default >/dev/null 2>&1; rc-update del nodedeck-singbox default >/dev/null 2>&1; rc-update del nodedeck-cf default >/dev/null 2>&1
rm -f /etc/init.d/nodedeck-agent /etc/init.d/nodedeck-singbox /etc/init.d/nodedeck-cf /var/log/nodedeck-*.log`,
  },
};
function svcOf(server) { return SVC[server.initSystem] || SVC.systemd; }

function singboxBase(state) { return String(state.settings?.singboxBase || '').replace(/\/+$/, ''); }

function agentConfig(state, server = {}) {
  const st = state.settings || {};
  const tg = st.telegram || {};
  const win = st.upgradeWindow && st.upgradeWindow.enabled ? [Number(st.upgradeWindow.start) || 0, Number(st.upgradeWindow.end) || 0] : [];
  const hy = server.protocols?.hysteria2;
  const hop = hy?.enabled ? core.hopRange(server, {}) : null;
  return {
    init: server.initSystem || 'systemd',
    vpsExpireAt: server.vpsExpireAt ? Math.floor(server.vpsExpireAt / 1000) : 0,
    udpHops: hop ? [{ from: hop[0], to: hop[1], port: Number(hy.port) }] : [],
    serverName: server.name || '',
    timezone: st.timezone || 'Asia/Shanghai',
    upgradeWindow: win,
    telegram: tg.enabled ? { botToken: tg.botToken || '', chatId: String(tg.chatId || ''), daily: tg.daily !== false, dailyHour: Number(tg.dailyHour ?? 9), warnDays: Number(tg.warnDays ?? 3), warnPercent: Number(tg.warnPercent ?? 90), ...(tg.apiBase ? { apiBase: tg.apiBase } : {}) } : {},
    singboxManifest: `${singboxBase(state)}/manifest.json`,
    singboxAutoUpdate: st.singboxAutoUpdate !== false,
    statsApi: `127.0.0.1:${st.statsPort || 9092}`,
    subListen: `:${st.subPort || 2096}`,
    adminListen: `127.0.0.1:${st.adminPort || 9091}`,
    dataDir: DIR,
    singbox: SB_BIN,
    service: 'nodedeck-singbox',
    reality: realityAgentCfg(state, server),
    speedToken: server.speedToken || '',
    latencyProbe: !!st.latencyProbe, // 后台定时测三网延迟，默认关（省流量）
    alerts: { off: st.alerts?.enabled === false, diskPct: Number(st.alerts?.diskPct) || 0, cpuPct: Number(st.alerts?.cpuPct) || 0, latencyMs: Number(st.alerts?.latencyMs) || 0 },
  };
}

function realityAgentCfg(state, server) {
  const pc = server.protocols?.vlessReality;
  if (!pc?.enabled) return null;
  return {
    mode: state.settings?.realityPatrol || 'auto',
    sni: pc.sni,
    publicKey: pc.publicKey,
    selfIp: /^\d+\.\d+\.\d+\.\d+$/.test(server.host || '') ? server.host : '',
    candidates: core.REALITY_FALLBACKS,
  };
}

// 在 VPS 上挑 Reality 目标：同网段邻居优先，找不到再从备选大站里挑最快的
async function pickRealityOn(ssh, server, log) {
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(server.host || '') ? server.host : '';
  log('寻找 Reality 目标（先扫同网段邻居网站，约 1 分钟）…');
  const r = await ssh.exec(`${AGENT_BIN} pick-reality -ip ${shq(ip)} -domains ${shq(core.REALITY_FALLBACKS.join(','))}`, { timeout: 240000 });
  let j = {};
  try { j = JSON.parse(r.stdout); } catch (_) { /* ignore */ }
  // 旧 agent 只返回一个 domain
  const all = Array.isArray(j.list) && j.list.length ? j.list : j.domain ? [{ domain: j.domain, source: j.source }] : [];
  const cands = all.filter((c) => c.domain && !core.sniBlocked(c.domain)).slice(0, 10);
  if (!cands.length) { log('⚠ 没找到合适的 Reality 目标，继续用 ' + server.protocols.vlessReality.sni); return null; }
  // VPS 上能用不代表国内能用：邻居网站可能在国内被屏蔽（客户端一连就被掐断）。从这台电脑（国内）再测一遍，按原来的优先顺序取第一个通过的
  log(`从这台电脑复测 ${cands.length} 个候选（排除在国内连不上的）…`);
  const local = await Promise.all(cands.map((c) => tools.realityCheck(c.domain, 6000).catch((e) => ({ ok: false, error: e.message }))));
  cands.forEach((c, i) => log(`  ${local[i].ok ? '✔' : '✗'} ${c.domain}${c.source === 'neighbor' ? '（邻居）' : ''}${local[i].ok ? `  ${local[i].ms} ms` : '：' + (local[i].error || '不通过')}`));
  let k = local.findIndex((x) => x.ok);
  if (k < 0) {
    // 本机全都测不通：多半是本机网络的问题，退回 VPS 测到的最快的大站（大站在国内基本都能连）
    k = Math.max(0, cands.findIndex((c) => c.source === 'fallback'));
    log(`⚠ 本机复测都没通过（可能是这台电脑的网络问题），先用 ${cands[k].domain}`);
  }
  const c = cands[k];
  return { domain: c.domain, source: c.source, check: { domain: c.domain, ok: true, at: Date.now(), where: 'vps', via: 'pick', localOk: !!local[k].ok } };
}

// 在 VPS 上被其它程序占用的 TCP 端口（不含我们自己的 sing-box）
async function busyTcpPorts(ssh) {
  const r = await ssh.exec(`(ss -Htlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -v nodedeck | grep -v 'sing-box'`);
  const out = new Set();
  for (const m of r.stdout.matchAll(/[:\]](\d{1,5})\s/g)) out.add(Number(m[1]));
  return [...out];
}

function agentGz(resourcesDir, arch) {
  const f = path.join(resourcesDir, 'agent', `nodedeck-agent-linux-${arch}.gz`);
  if (!fs.existsSync(f)) throw new Error(`缺少 agent 文件：${f}（请用 GitHub Actions 构建的安装包，或先运行 scripts/build-agent.sh）`);
  return fs.readFileSync(f);
}

async function detect(ssh) {
  const out = await ssh.run(`
set -e
case "$(uname -m)" in x86_64|amd64) echo ARCH=amd64;; aarch64|arm64) echo ARCH=arm64;; armv7*|armv8l) echo ARCH=arm;; i386|i686) echo ARCH=386;; *) echo ARCH=unsupported;; esac
if command -v systemctl >/dev/null && { [ -d /run/systemd/system ] || ! command -v rc-service >/dev/null; }; then echo INIT=systemd
elif command -v rc-service >/dev/null && command -v openrc-run >/dev/null; then echo INIT=openrc
else echo INIT=none; fi
command -v curl >/dev/null && echo CURL=1 || echo CURL=0
command -v wget >/dev/null && echo WGET=1 || echo WGET=0
. /etc/os-release 2>/dev/null && echo "OS=$PRETTY_NAME" || echo OS=unknown
echo "CPUS=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
echo "MEMKB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
echo "SWAPKB=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)"
echo "DISKFREEKB=$(df -Pk / | awk 'NR==2{print $4}')"
echo "DISKTOTALKB=$(df -Pk / | awk 'NR==2{print $2}')"
if [ -f /proc/user_beancounters ]; then echo VIRT=openvz
elif grep -qa 'container=' /proc/1/environ 2>/dev/null; then echo VIRT=container
else echo "VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown)"; fi
`);
  const kv = {};
  for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return kv;
}

// 自签证书：没有或域名变了就重新生成。证书变了指纹也会变，分享链接和订阅随之更新
async function ensureSelfCert(ssh, server, log) {
  const sni = server.tlsSni || 'www.bing.com';
  const r = await ssh.run(`
if [ ! -f ${DIR}/cert.pem ] || [ "$(cat ${DIR}/cert.sni 2>/dev/null)" != ${shq(sni)} ]; then
  ${AGENT_BIN} gencert -host ${shq(sni)} -dir ${DIR} && printf %s ${shq(sni)} > ${DIR}/cert.sni && echo NEWCERT
fi`);
  if (r.includes('NEWCERT') && server.deployedAt) log(`自签证书已按新域名 ${sni} 重新生成，证书指纹变了，用户需要刷新一次订阅`);
}

function rememberHw(server, info) {
  const n = (k) => Number(info[k]) || 0;
  server.hw = { cpus: n('CPUS'), memMB: Math.round(n('MEMKB') / 1024), swapMB: Math.round(n('SWAPKB') / 1024), diskFreeMB: Math.round(n('DISKFREEKB') / 1024), diskTotalMB: Math.round(n('DISKTOTALKB') / 1024), virt: info.VIRT || '', at: Date.now() };
}

function hwSummary(hw) {
  if (!hw?.memMB) return '';
  const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
  return `配置：${hw.cpus || '?'} 核 / 内存 ${gb(hw.memMB)}${hw.swapMB ? ` + swap ${gb(hw.swapMB)}` : '（没有 swap）'} / 磁盘剩余 ${gb(hw.diskFreeMB)}（共 ${gb(hw.diskTotalMB)}）。` +
    `NodeDeck 在 VPS 上占用：内存空闲时约 50MB，每个正在传数据的连接再加 0.5–0.8MB；磁盘约 100MB，升级内核时临时再用 70MB`;
}

// 写系统服务文件（内容按机器内存调整）；有变化返回 true
async function writeUnits(ssh, server) {
  const lim = memLimits(server.hw?.memMB);
  const files = server.initSystem === 'openrc'
    ? [['/etc/init.d/nodedeck-singbox', openrcSb(lim), '755'], ['/etc/init.d/nodedeck-agent', openrcAgent(lim), '755']]
    : [['/etc/systemd/system/nodedeck-singbox.service', sbUnit(lim), '644'], ['/etc/systemd/system/nodedeck-agent.service', agentUnit(lim), '644']];
  let changed = false;
  for (const [f, body, mode] of files) {
    const cur = (await ssh.exec(`cat ${f} 2>/dev/null`)).stdout;
    if (cur.trim() === body.trim()) continue;
    await ssh.writeFile(f, body, mode);
    changed = true;
  }
  if (changed && server.initSystem !== 'openrc') await ssh.run('systemctl daemon-reload');
  return changed;
}

// 内存 2GB 及以下、没有 swap 的机器自动加 swap（原来是 1.5GB）。
// 卖家常见的 2GB 套餐系统里显示约 1.9~2.0GB，留点余量写 2560；3GB 以上一般不缺内存
const SWAP_MAX_MEM_MB = 2560;
// swap 大小：1GB 内存配 1GB，更大的配 2GB；磁盘要留够余量（swap 之外至少再剩 1.5GB），不够就减半，再不够就不加
function swapSize(memMB, diskFreeMB) {
  for (const size of [memMB <= 1024 ? 1024 : 2048, 1024, 512]) {
    if (diskFreeMB >= size + 1536 + (size >= 2048 ? 1024 : 0)) return size;
  }
  return 0;
}

// 小内存 / 小磁盘 VPS 的系统优化（可在设置里关闭）：
// 1. 内存 ≤ 2GB 且没有 swap：建一个 swap 文件（磁盘够才建；OpenVZ / 容器不支持就跳过），防止流量高峰时被系统杀进程
// 2. 磁盘 < 20GB 的 systemd 系统：限制系统日志最多 200MB（Debian 默认最多可占磁盘的 10%）
async function tuneSmallBox(ssh, state, server, info, log) {
  if (state.settings?.smallBoxTuning === false) return;
  const hw = server.hw || {};
  if (hw.memMB && hw.memMB <= SWAP_MAX_MEM_MB && !hw.swapMB) {
    if (['openvz', 'container', 'lxc', 'lxc-libvirt'].includes(hw.virt)) log('这台是 OpenVZ / 容器，不能加 swap，跳过');
    else {
      const size = swapSize(hw.memMB, hw.diskFreeMB);
      if (!size) log(`磁盘只剩 ${hw.diskFreeMB}MB，不加 swap`);
      else {
        log(`内存 ${hw.memMB}MB 且没有 swap，添加 ${size}MB swap（防止流量高峰时内存不够）…`);
        const r = await ssh.exec(`set -e
[ -f /nodedeck.swap ] || { fallocate -l ${size}M /nodedeck.swap 2>/dev/null || dd if=/dev/zero of=/nodedeck.swap bs=1M count=${size} status=none; }
chmod 600 /nodedeck.swap
mkswap /nodedeck.swap >/dev/null
swapon /nodedeck.swap
grep -q '^/nodedeck.swap ' /etc/fstab || echo '/nodedeck.swap none swap sw 0 0' >> /etc/fstab
printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-nodedeck-swap.conf
sysctl -q -w vm.swappiness=10 || true`);
        if (r.code === 0) { hw.swapMB = size; log('✔ swap 已添加'); } else { await ssh.exec('swapoff /nodedeck.swap 2>/dev/null; rm -f /nodedeck.swap'); log('⚠ 添加 swap 失败（不影响使用）：' + (r.stderr || r.stdout).trim().slice(0, 200)); }
      }
    }
  }
  if (server.initSystem !== 'openrc' && hw.diskTotalMB && hw.diskTotalMB < 20480) {
    const r = await ssh.exec(`[ -f /etc/systemd/journald.conf.d/nodedeck.conf ] && echo HAVE || { mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\n# NodeDeck：小磁盘 VPS 限制系统日志大小\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/nodedeck.conf && systemctl restart systemd-journald && echo SET; }`);
    if (r.stdout.includes('SET')) log('磁盘较小，系统日志最多保留 200MB');
  }
}

// 放行防火墙端口（ufw / firewalld），部署和每次同步都会执行，保证新加的端口也能通
async function openFirewall(ssh, state, server) {
  const ports = core.serverPorts(state, server);
  const fw = ports.map(({ port, net, range }) => {
    const nets = net === 'both' || !net ? ['tcp', 'udp'] : [net];
    const spec = range ? `${range[0]}:${range[1]}` : String(port);
    const fspec = range ? `${range[0]}-${range[1]}` : String(port);
    return nets.map((n) => `[ -n "$UFW" ] && ufw allow ${spec}/${n} >/dev/null 2>&1; [ -n "$FWD" ] && firewall-cmd -q --permanent --add-port=${fspec}/${n} 2>/dev/null`).join('; ');
  }).join('\n');
  await ssh.run(`
UFW=; FWD=
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then UFW=1; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then FWD=1; fi
${fw}
[ -n "$FWD" ] && firewall-cmd -q --reload
true`);
}

// 完整部署：安装依赖、sing-box、agent、证书、systemd、防火墙，然后同步配置
async function deployServer(state, server, { resourcesDir, log }) {
  const errs = core.checkPortConflicts(state, server);
  if (errs.length) throw new Error(errs.join('；'));
  log('§ssh');
  return withSSH(server, async (ssh) => {
    log(`已连接 ${server.host}`);
    if (ssh.sudo) {
      const r = await ssh.exec('true');
      if (r.code !== 0) throw new Error('当前用户无法免密 sudo，请使用 root 或配置 NOPASSWD');
    }
    const info = await detect(ssh);
    log(`系统：${info.OS}，架构：${info.ARCH}`);
    rememberHw(server, info);
    log(hwSummary(server.hw));
    if (info.ARCH === 'unsupported') throw new Error('不支持的 CPU 架构');
    if (info.INIT === 'none') throw new Error('系统既没有 systemd 也没有 OpenRC，暂不支持');
    server.initSystem = info.INIT;

    log('§agent');
    log('上传 agent …');
    await ssh.run(`mkdir -p ${DIR} && chmod 700 ${DIR}`);
    await ssh.writeGz(AGENT_BIN, agentGz(resourcesDir, info.ARCH));

    const manifest = agentConfig(state).singboxManifest;
    log('§kernel');
    await ensureDNS(ssh, log, true);
    log(`安装 sing-box（${manifest}）…`);
    const v = await ssh.run(`${AGENT_BIN} install-singbox -manifest ${shq(manifest)} -bin ${SB_BIN}`);
    log(v.trim() + '（已校验 sha256）');

    log('生成自签证书 …');
    await ensureSelfCert(ssh, server, log);

    await ssh.writeFile(`${DIR}/agent.json`, JSON.stringify(agentConfig(state, server), null, 2));
    await writeUnits(ssh, server);
    await tuneSmallBox(ssh, state, server, info, log);

    // BBR + fq：部署时默认写进去（持久化，原值备份，可在「网络优化」里恢复）
    log('开启 BBR …');
    const ccKeys = 'net.ipv4.tcp_congestion_control,net.core.default_qdisc';
    try {
      const r = await agentJSON(ssh, `net-tune -c ${DIR}/agent.json -domains ${ccKeys}`);
      const cc = r.info?.cc;
      if (r.done?.length) for (const d of r.done) log('  ' + d);
      if (!r.info?.bbrSupport) log('  ⚠ ' + (r.info?.bbrNote || '这个内核不支持 BBR'));
      else log(cc === 'bbr' ? '  ✔ BBR 已开启' : '  ⚠ BBR 没开成：' + (r.error || cc));
      if (r.error && r.info?.bbrSupport) log('  ⚠ ' + r.error);
    } catch (e) {
      // agent 出问题时用老办法直接写
      log('  agent 没能处理（' + e.message + '），直接写入系统配置');
      await ssh.run(`
mkdir -p /etc/sysctl.d
grep -q tcp_congestion_control /etc/sysctl.d/99-nodedeck-net.conf 2>/dev/null || printf 'net.core.default_qdisc = fq\\nnet.ipv4.tcp_congestion_control = bbr\\n' >> /etc/sysctl.d/99-nodedeck-net.conf
modprobe tcp_bbr 2>/dev/null; sysctl -w net.core.default_qdisc=fq >/dev/null 2>&1; sysctl -w net.ipv4.tcp_congestion_control=bbr >/dev/null 2>&1; true`);
    }
    // 其余网络优化（缓冲区、MTU 探测等）：检测后只改有依据的几项，设置里可关
    if (state.settings?.netAutoTune !== false) {
      log('检测其它网络设置并优化（缓冲区等，原值已备份）…');
      try {
        const r = await agentJSON(ssh, `net-tune -c ${DIR}/agent.json`);
        server.netTunedAt = Date.now();
        const rest = (r.done || []).filter((d) => !/^TCP 拥塞控制|^发包队列/.test(d));
        if (rest.length) for (const d of rest) log('  ' + d);
        else log('  现有设置已经合适，没有改动');
        if (r.error && !/发包队列/.test(r.error)) log('  ⚠ ' + r.error);
      } catch (e) { log('⚠ 网络优化没做成（不影响使用）：' + e.message); }
    }
    log('§reality');
    // 端口：被 VPS 上其它程序占了的，换成优先端口（443 → 8443 → 2053 …）或随机端口
    const busy = await busyTcpPorts(ssh);
    for (const [k, meta] of Object.entries(core.PROTOCOLS)) {
      const pc = server.protocols?.[k];
      if (!pc?.enabled || pc.fixedPort || !core.netsOf(meta.net).includes('tcp') || !busy.includes(Number(pc.port))) continue;
      const np = core.pickPreferredPort(state, server, k, busy) || core.pickFreePort(state, server, k, busy);
      log(`${meta.label} 端口 ${pc.port} 已被 VPS 上其它程序占用，改用 ${np}`);
      pc.port = np;
    }
    // Reality 目标：新服务器自动挑（用户手动改过 SNI 的不动）
    const rp = server.protocols?.vlessReality;
    if (rp?.enabled && rp.sniAuto && !rp.sniPickedAt) {
      const pick = await pickRealityOn(ssh, server, log).catch((e) => { log('⚠ 挑选 Reality 目标出错：' + e.message); return null; });
      if (pick) {
        Object.assign(rp, { sni: pick.domain, sniSource: pick.source, sniPickedAt: Date.now(), sniCheck: pick.check });
        log(`✔ Reality 目标：${pick.domain}（${pick.source === 'neighbor' ? '同网段邻居' : '备选大站里最快的'}）`);
      }
    }
    await gateRealityTarget(ssh, server, log, true);
    await ssh.writeFile(`${DIR}/agent.json`, JSON.stringify(agentConfig(state, server), null, 2));

    log('§firewall');
    await openFirewall(ssh, state, server);

    log('§config');
    await pushConfig(ssh, state, server, log);
    log('§start');
    await ssh.run(svcOf(server).install);
    await ssh.run(svcOf(server).restartAgent);
    await new Promise((r) => setTimeout(r, 2500));
    const st = await status(ssh, server);
    if (!st.singbox || !st.agent) {
      const j = await ssh.exec(svcOf(server).logs);
      throw new Error('服务未正常启动：\n' + j.stdout);
    }
    log('部署完成 ✔');
    return st;
  }, { log });
}

async function pushConfig(ssh, state, server, log = () => {}) {
  // WARP 分流：第一次开启时在 VPS 上注册一个免费 WARP 账号
  if (server.routing?.warp?.enabled && !server.warp?.privateKey) {
    log('注册 Cloudflare WARP 账号 …');
    const r = await ssh.exec(`${AGENT_BIN} warp-register ${server.warpReset ? '-force ' : ''}-out ${DIR}/warp.json`);
    if (r.code !== 0) throw new Error('WARP 注册失败：' + (r.stderr || r.stdout).trim() + '（可以先在服务器设置里关掉 WARP 分流）');
    server.warp = JSON.parse(r.stdout);
    delete server.warpReset;
    log(`WARP 账号已注册（${server.warp.address4}）`);
  }
  if (core.usesAcme(server)) {
    try {
      const ips = await require('dns').promises.resolve4(server.domain);
      if (!ips.includes(server.host)) log(`⚠ 域名 ${server.domain} 解析到 ${ips.join(', ')}，不是这台服务器（${server.host}）。证书会申请失败：请把 A 记录指向服务器 IP，并关闭 Cloudflare 小黄云`);
    } catch (e) { log(`⚠ 查不到域名 ${server.domain} 的解析（${e.code || e.message}），证书可能申请失败`); }
  }
  // agent 巡检时自己换过 Reality 目标：以 VPS 上的为准，避免把它改回已经失效的旧目标
  const rp = server.protocols?.vlessReality;
  if (rp?.enabled) {
    const o = (await ssh.exec(`cat ${DIR}/reality.json 2>/dev/null`)).stdout;
    try {
      const j = JSON.parse(o || '{}');
      if (j.override && j.from === rp.sni) { log(`Reality 目标已被 VPS 自动换成 ${j.override}（原 ${rp.sni} 不可用），同步到本地`); Object.assign(rp, { sni: j.override, sniSource: 'patrol', sniPickedAt: (j.changedAt || 0) * 1000, sniCheck: { domain: j.override, ok: true, at: (j.changedAt || 0) * 1000, where: 'vps', via: 'patrol' } }); }
    } catch (_) { /* ignore */ }
  }
  await gateRealityTarget(ssh, server, log, false);
  // 自签证书域名改过的话重新生成证书（以前只有部署时才生成，同步不会更新）
  await ensureSelfCert(ssh, server, log);
  // 记下自签证书的指纹，分享链接里要带上（新版 v2rayNG 不再支持跳过证书验证）
  try {
    const pem = (await ssh.exec(`cat ${DIR}/cert.pem 2>/dev/null`)).stdout;
    if (pem.includes('BEGIN CERTIFICATE')) {
      const x = new crypto.X509Certificate(pem);
      server.certSha256 = x.fingerprint256.replace(/:/g, '').toLowerCase();
      // sing-box 客户端按公钥指纹校验自签证书（certificate_public_key_sha256，1.13 起支持）
      server.certSpki = crypto.createHash('sha256').update(x.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    }
  } catch { /* 读不到就不带指纹 */ }
  const full = core.buildServerConfig(state, server);
  await ssh.writeFile(`${DIR}/config.full.json`, JSON.stringify(full, null, 2));
  await ssh.writeFile(`${DIR}/users.json`, JSON.stringify(core.buildAgentUsers(state, server)));
  const subs = core.buildAgentSubs(state, server);
  for (const sub of Object.values(subs)) if (sub.url) sub.qr = await QRCode.toDataURL(sub.url, { margin: 1, width: 240 });
  await ssh.writeFile(`${DIR}/subs.json`, JSON.stringify(subs));
  // 校验
  const r = await ssh.exec(`${SB_BIN} check -c ${DIR}/config.full.json`);
  if (r.code !== 0) throw new Error('sing-box 配置校验失败：' + (r.stderr || r.stdout));
  await syncTunnel(ssh, server, log);
  if (rp?.enabled) rp.sniDeployed = rp.sni;
  log('配置已上传');
}

// Cloudflare 隧道：开了就写 cf.json 并（重）启 nodedeck-cf，关了就停掉删掉
async function syncTunnel(ssh, server, log) {
  const cfg = core.buildTunnelConfig(server);
  const svc = svcOf(server);
  if (!cfg) { await ssh.exec(`${svc.cfOff}; rm -f ${DIR}/cf.json`); return; }
  const body = JSON.stringify(cfg, null, 2);
  const old = await ssh.exec(`cat ${DIR}/cf.json 2>/dev/null`);
  const running = (await ssh.exec(svc.active('nodedeck-cf'))).stdout.trim() === 'active';
  if (old.stdout.trim() === body.trim() && running) return; // 没变化就不重启隧道
  await ssh.writeFile(`${DIR}/cf.json`, body);
  const c = await ssh.exec(`${SB_BIN} check -c ${DIR}/cf.json`);
  if (c.code !== 0) throw new Error('Cloudflare 隧道配置校验失败：' + (c.stderr || c.stdout).trim() + '（sing-box 内核可能太旧，先在「更多」里升级内核）');
  log('启动 Cloudflare 隧道 …');
  await ssh.run(svc.cfOn(CF_UNIT));
  await new Promise((r) => setTimeout(r, 4000));
  if ((await ssh.exec(svc.active('nodedeck-cf'))).stdout.trim() !== 'active') {
    const j = await ssh.exec(server.initSystem === 'openrc' ? 'tail -n 5 /var/log/nodedeck-cf.log' : 'journalctl -u nodedeck-cf -n 5 --no-pager -o cat');
    log('⚠ Cloudflare 隧道没起来（不影响其它节点），会每 15 秒自动重试。日志：\n' + j.stdout.trim());
  }
}

async function status(ssh, server = {}) {
  const svc = svcOf(server);
  const r = await ssh.exec(`
echo SB=$(${svc.active('nodedeck-singbox')})
echo AG=$(${svc.active('nodedeck-agent')})
echo CF=$(${svc.active('nodedeck-cf')})
echo VER=$(${SB_BIN} version 2>/dev/null | head -1 | awk '{print $3}')
echo AGV=$(${AGENT_BIN} version 2>/dev/null)
echo LOAD=$(cut -d' ' -f1-3 /proc/loadavg)
echo MEM=$(free -m | awk '/Mem:/{print $3"/"$2"MB"}')
echo UP=$(uptime -p 2>/dev/null)
echo UPS=$(cut -d. -f1 /proc/uptime)
echo CPUS=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
echo MEMI=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print int((t-a)/1024)" "int(t/1024)}' /proc/meminfo)
echo DISK=$(df -Pm / | awk 'NR==2{print $3" "$2}')
echo CPU=$(a=$(head -1 /proc/stat); sleep 0.5; b=$(head -1 /proc/stat); printf '%s|%s' "$a" "$b" | awk -F'|' '{n=split($1,x," "); split($2,y," "); for(i=2;i<=9&&i<=n;i++){ta+=x[i]; tb+=y[i]}; d=tb-ta; printf "%.0f", (d > 0 ? 100*(1-((y[5]+y[6])-(x[5]+x[6]))/d) : 0)}')
echo IP6=$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/{print $2}' | cut -d/ -f1 | grep -v '^f[cd]' | head -1)
`);
  const kv = {};
  for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  const nums = (v) => String(v || '').split(/\s+/).map(Number);
  const [memUsed, memTotal] = nums(kv.MEMI);
  const [diskUsed, diskTotal] = nums(kv.DISK);
  return {
    singbox: kv.SB === 'active', agent: kv.AG === 'active', version: kv.VER || '', agentVersion: kv.AGV || '', cf: kv.CF === 'active', ipv6: kv.IP6 || '', load: kv.LOAD, mem: kv.MEM, uptime: kv.UP,
    // 给服务器列表画仪表用（MB）
    memUsed: memUsed || 0, memTotal: memTotal || 0, diskUsed: diskUsed || 0, diskTotal: diskTotal || 0, cpus: Number(kv.CPUS) || 0, cpu: kv.CPU === '' || kv.CPU == null ? null : Number(kv.CPU), uptimeSec: Number(kv.UPS) || 0, at: Date.now(),
  };
}

// 同步：推送配置；如果 agent 版本和本软件不一致（软件更新过），顺便升级 agent
async function syncServer(state, server, { log = () => {}, resourcesDir, appVersion } = {}) {
  return withSSH(server, async (ssh) => {
    await pushConfig(ssh, state, server, log);
    await openFirewall(ssh, state, server);
    let restart = false;
    const cfgText = JSON.stringify(agentConfig(state, server), null, 2);
    const curCfg = (await ssh.exec(`cat ${DIR}/agent.json`)).stdout;
    if (curCfg.trim() !== cfgText.trim()) { await ssh.writeFile(`${DIR}/agent.json`, cfgText); restart = true; }
    // 每次同步顺便刷新机器配置、服务文件（内存上限）和小机器优化
    const info = await detect(ssh);
    rememberHw(server, info);
    if (info.INIT === 'systemd' || info.INIT === 'openrc') server.initSystem = info.INIT;
    if (await writeUnits(ssh, server)) { log('服务配置已更新（按内存调整）'); await ssh.run(`${svcOf(server).restartSb || 'true'}`); restart = true; }
    await tuneSmallBox(ssh, state, server, info, log);
    const agv = (await ssh.exec(`${AGENT_BIN} version`)).stdout.trim();
    if (resourcesDir && appVersion && agv !== appVersion) {
      log(`升级 agent ${agv || '?'} → ${appVersion}`);
      await ssh.writeGz(AGENT_BIN, agentGz(resourcesDir, info.ARCH));
      restart = true;
    }
    await ensureDNS(ssh, log, false).catch(() => {});
    if (restart) {
      await ssh.run(svcOf(server).restartAgent);
      await new Promise((res) => setTimeout(res, 2500));
    } else {
      const r = await ssh.exec(`${AGENT_BIN} apply -c ${DIR}/agent.json`);
      if (r.code !== 0) {
        await ssh.run(svcOf(server).restartAgent);
        await new Promise((res) => setTimeout(res, 2500));
      }
    }
    return status(ssh, server);
  }, { log });
}

async function updateSingbox(server) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`${AGENT_BIN} update-singbox -c ${DIR}/agent.json`, { timeout: 360000 });
    let j = {};
    try { j = JSON.parse(r.stdout); } catch (_) { /* ignore */ }
    if (r.code !== 0) throw new Error(j.error || r.stderr || r.stdout);
    return { message: j.message, status: await status(ssh, server) };
  });
}

async function fetchMetrics(server, range) {
  return withSSH(server, async (ssh) => JSON.parse(await ssh.run(`${AGENT_BIN} metrics -c ${DIR}/agent.json -range ${shq(range || '24h')}`)));
}

async function scanReality(server) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`${AGENT_BIN} scan-reality -ip ${shq(server.host)}`, { timeout: 180000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || '扫描失败');
    return JSON.parse(r.stdout || '[]') || [];
  });
}

async function notifyTest(server) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`${AGENT_BIN} notify-test -c ${DIR}/agent.json`);
    let j = {};
    try { j = JSON.parse(r.stdout); } catch (_) { /* ignore */ }
    if (r.code !== 0) throw new Error(j.error || r.stderr || r.stdout || '发送失败');
    return true;
  });
}

async function serverStatus(server) { return withSSH(server, (ssh) => status(ssh, server)); }

async function fetchStats(server, state) {
  return withSSH(server, async (ssh) => {
    const out = await ssh.run(`${AGENT_BIN} stats -c ${DIR}/agent.json`);
    return JSON.parse(out);
  });
}

async function resetTraffic(server, userId) {
  return withSSH(server, (ssh) => ssh.run(`${AGENT_BIN} reset -c ${DIR}/agent.json ${shq(userId || '*')}`));
}

async function serverLogs(server) {
  return withSSH(server, async (ssh) => (await ssh.exec(svcOf(server).logs)).stdout);
}

async function uninstall(server) {
  return withSSH(server, (ssh) => ssh.run(`
echo '{}' > /tmp/nodedeck-empty.json && ${AGENT_BIN} apply-hops -c /tmp/nodedeck-empty.json >/dev/null 2>&1; rm -f /tmp/nodedeck-empty.json
# DNS 还原（部署时改过才会动；原来的 DNS 仍然不通就保留现在的）
${AGENT_BIN} dns-restore -c ${DIR}/agent.json >/dev/null 2>&1
# 网络优化恢复成部署前的原值（有备份才会改）
${AGENT_BIN} net-restore -c ${DIR}/agent.json >/dev/null 2>&1; rm -f /etc/sysctl.d/99-nodedeck-net.conf /etc/modules-load.d/nodedeck-bbr.conf
${svcOf(server).remove}
rm -f ${AGENT_BIN} ${SB_BIN} ${SB_BIN}.old ${SB_BIN}.bad
rm -rf ${DIR} /root/.nodedeck-bench
# NodeDeck 加的 swap、日志限制、BBR 以外的系统改动一并撤销
if grep -q '^/nodedeck.swap ' /etc/fstab 2>/dev/null; then swapoff /nodedeck.swap 2>/dev/null; sed -i '\#^/nodedeck.swap #d' /etc/fstab; rm -f /nodedeck.swap /etc/sysctl.d/99-nodedeck-swap.conf; fi
if [ -f /etc/systemd/journald.conf.d/nodedeck.conf ]; then rm -f /etc/systemd/journald.conf.d/nodedeck.conf; systemctl restart systemd-journald 2>/dev/null; fi
echo ok`));
}

async function testSSH(server) {
  return withSSH(server, async (ssh) => {
    const info = await detect(ssh);
    if (ssh.sudo) {
      const r = await ssh.exec('true');
      if (r.code !== 0) info.warn = '非 root 用户且不能免密 sudo，部署会失败';
    }
    return info;
  });
}

// 体检用：服务器上的服务状态、出网和出口 IP、本机监听的端口
async function serverSelfCheck(server, { log } = {}) {
  return withSSH(server, async (ssh) => {
    const st = await status(ssh, server);
    const r = await ssh.exec(`
T=$( (curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 8 https://www.gstatic.com/generate_204 || wget -q -T 8 -O /dev/null https://www.gstatic.com/generate_204 && echo '204 0') 2>/dev/null)
echo "NET=$T"
echo "IP=$(curl -s --max-time 8 'http://ip-api.com/line/?fields=query,country,isp' 2>/dev/null | tr '\\n' '|')"
echo "LISTEN=$( (ss -lntuH 2>/dev/null || netstat -lntu 2>/dev/null) | awk '{print $1"/"$5}' | sed -E 's#/.*:#/#' | sort -u | tr '\\n' ' ')"
echo "TIME=$(date +%s)"
`, { root: false });
    const kv = {};
    for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const [code, secs] = (kv.NET || '').split(' ');
    const ipParts = (kv.IP || '').split('|');
    const listening = new Set();
    for (const t of (kv.LISTEN || '').split(' ')) { const m = t.match(/^(tcp|udp)\/(\d+)$/); if (m) listening.add(`${m[1]}/${m[2]}`); }
    return {
      status: st,
      via: ssh.via,
      netOk: code === '204',
      netMs: secs ? Math.round(Number(secs) * 1000) : null,
      // ip-api 的 line 格式按固定顺序输出：country, isp, query
      exitCountry: ipParts[0] || '', exitIsp: ipParts[1] || '', exitIp: ipParts[2] || '',
      listening: [...listening],
      clockSkew: kv.TIME ? Math.round(Number(kv.TIME) - Date.now() / 1000) : null,
    };
  }, { log });
}

// 在服务器上测试 Reality 目标域名（延迟应尽量低）
// 系统 DNS 自检：解析不了域名（比如 resolv.conf 写的是连不上的内网地址）就换成能通的公共 DNS。
// 不修的话下载内核、申请证书都会失败，sing-box 也解析不了用户访问的网站
async function ensureDNS(ssh, log, strict) {
  let r;
  try { r = await agentJSON(ssh, `dns-fix -c ${DIR}/agent.json`, 90000); } catch (e) { if (strict) log('  DNS 自检跳过：' + e.message); return; }
  if (r.fixed && r.ok) log(`VPS 的 DNS 服务器（${(r.old || []).join('、') || '无'}）解析不了域名，已改成 ${r.new.join('、')}（原配置已备份，卸载时还原）`);
  else if (!r.ok) {
    if (strict) throw new Error(r.error || 'VPS 解析不了域名');
    log('⚠ ' + (r.error || 'VPS 解析不了域名'));
  }
}

// 运行 agent 的一个返回 JSON 的命令
async function agentJSON(ssh, args, timeout = 120000) {
  const r = await ssh.exec(`${AGENT_BIN} ${args}`, { timeout });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) {
    if (/unknown|未知命令|用法/i.test(r.stdout + r.stderr)) throw new Error('VPS 上的 agent 太旧，先点「同步」升级');
    throw new Error((r.stderr || r.stdout || '没有返回结果').trim().slice(0, 300));
  }
}

// ---------- 网络优化（agent 命令的包装）----------
const netInfo = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-info -c ${DIR}/agent.json`));
const netTune = (server, keys = []) => withSSH(server, (ssh) => agentJSON(ssh, `net-tune -c ${DIR}/agent.json${keys.length ? ' -domains ' + shq(keys.join(',')) : ''}`));
const netRestore = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-restore -c ${DIR}/agent.json`));
const netTrace = (server) => withSSH(server, (ssh) => agentJSON(ssh, `trace -c ${DIR}/agent.json`, 180000));
const netPing = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-ping -c ${DIR}/agent.json`, 60000));
const netMtu = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-mtu -c ${DIR}/agent.json`, 120000));
const netTcp = (ssh) => agentJSON(ssh, `net-tcp -c ${DIR}/agent.json`);
const netSetCC = (ssh, cc) => agentJSON(ssh, `net-cc -c ${DIR}/agent.json -text ${shq(cc)}`);

// ---------- 社区测试脚本（NodeQuality / TcpQuality）：在 VPS 后台运行，断开 SSH 也不影响 ----------
const BENCH_DIR = '/root/.nodedeck-bench';
const BENCH = {
  nodequality: (o) => `printf '%s\\n' ${shq(o.hq || 'f')} ${shq(o.iq || 'y')} ${shq(o.nq || 'l')} ${shq(o.bt || 'y')} n n n n | bash <(curl -sL https://run.NodeQuality.com)`,
  tcpquality: (o) => `bash <(curl -fsSL https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh)${o.speedtest ? ' --speedtest' : ''}${o.v4 ? ' -v4' : ''}`,
};
const BENCH_URL = /https?:\/\/(?:www\.)?(?:nodequality\.com|tcpquality\.ibsgss\.uk)\/r\/[A-Za-z0-9_-]+/g;

async function benchStart(server, kind, opts = {}) {
  if (!BENCH[kind]) throw new Error('未知的测试');
  return withSSH(server, async (ssh) => {
    // 精简系统常常没装 curl（Debian 最小安装只有 wget），测试脚本要用：缺了就先装上
    const need = await ssh.exec('command -v bash >/dev/null && command -v curl >/dev/null && echo OK');
    if (!need.stdout.includes('OK')) {
      await ssh.exec(`if command -v apt-get >/dev/null; then (apt-get update -qq || true) && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl bash; elif command -v dnf >/dev/null; then dnf install -y -q curl bash; elif command -v yum >/dev/null; then yum install -y -q curl bash; elif command -v apk >/dev/null; then apk add --no-cache -q curl bash; fi`, { timeout: 240000 });
    }
    const chk = await ssh.exec(`command -v bash >/dev/null && command -v curl >/dev/null && echo OK; df -Pm /root | awk 'NR==2{print $4}'; [ -f ${BENCH_DIR}/${kind}.pid ] && kill -0 "$(cat ${BENCH_DIR}/${kind}.pid)" 2>/dev/null && echo RUNNING`);
    if (!chk.stdout.includes('OK')) throw new Error('VPS 上缺少 bash 或 curl，自动安装也失败了。可以 SSH 登录后手动安装（Debian / Ubuntu：apt install curl；Alpine：apk add bash curl）');
    if (chk.stdout.includes('RUNNING')) return { running: true, already: true };
    const free = Number((chk.stdout.match(/^\d+$/m) || [0])[0]);
    if (free && free < 1024) throw new Error(`磁盘只剩 ${free}MB，测试脚本需要下载临时系统，至少要 1GB 空闲`);
    const script = `#!/bin/bash\nexport TERM=xterm LANG=C.UTF-8\ncd ${BENCH_DIR}\n${BENCH[kind](opts)}\nrc=$?\necho\necho "[nodedeck] 测试结束（退出码 $rc）"\n`;
    await ssh.run(`mkdir -p ${BENCH_DIR} && chmod 700 ${BENCH_DIR}`);
    await ssh.writeFile(`${BENCH_DIR}/${kind}.sh`, script, '700');
    await ssh.run(`cd ${BENCH_DIR} && : > ${kind}.log && (setsid nohup bash ${kind}.sh > ${kind}.log 2>&1 < /dev/null & echo $! > ${kind}.pid)`);
    return { running: true };
  });
}

// 读取后台测试的输出（从 offset 开始），返回去掉颜色码的文本、是否还在运行、报告链接
async function benchPoll(server, kind, offset = 0) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`f=${BENCH_DIR}/${kind}.log; [ -f "$f" ] || { echo NOLOG; exit 0; }; s=$(wc -c < "$f"); echo "SIZE=$s"; echo "START=$(stat -c %Y ${BENCH_DIR}/${kind}.pid 2>/dev/null)"; echo "END=$(stat -c %Y "$f")"; echo "NOW=$(date +%s)"; ( [ -f ${BENCH_DIR}/${kind}.pid ] && kill -0 "$(cat ${BENCH_DIR}/${kind}.pid)" 2>/dev/null ) && echo RUN=1 || echo RUN=0; echo ---; tail -c +$(( ${Number(offset) || 0} + 1 )) "$f" | head -c 200000`);
    if (r.stdout.startsWith('NOLOG')) return { none: true };
    const [head, ...rest] = r.stdout.split('\n---\n');
    const total = Number((head.match(/SIZE=(\d+)/) || [])[1] || 0);
    const running = /RUN=1/.test(head);
    let raw = rest.join('\n---\n');
    // 只取到最后一个换行为止：避免把一个汉字从中间切开，也避免一次读不完（最多 200KB）时丢掉后面的内容
    const cut = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r'));
    if (running || total > (Number(offset) || 0) + Buffer.byteLength(raw)) raw = cut >= 0 ? raw.slice(0, cut + 1) : '';
    const size = (Number(offset) || 0) + Buffer.byteLength(raw);
    // 保留单独的 \r（进度条原地刷新），界面那边按终端的方式处理
    const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r\n/g, '\n');
    const all = (await ssh.exec(`cat ${BENCH_DIR}/${kind}.log 2>/dev/null | tr -d '\\033'`)).stdout;
    const urls = [...new Set(all.match(BENCH_URL) || [])];
    const num = (k) => Number((head.match(new RegExp(k + '=(\\d+)')) || [])[1] || 0);
    // 用时：按 VPS 的时钟算（开始 = pid 文件时间，结束 = 日志最后写入时间）
    const elapsed = num('START') ? (running ? num('NOW') : num('END')) - num('START') : 0;
    return { size, running, text, url: urls[urls.length - 1] || '', elapsed: Math.max(0, elapsed) };
  });
}

async function benchStop(server, kind) {
  return withSSH(server, (ssh) => ssh.exec(`[ -f ${BENCH_DIR}/${kind}.pid ] && kill -INT -"$(cat ${BENCH_DIR}/${kind}.pid)" 2>/dev/null; kill "$(cat ${BENCH_DIR}/${kind}.pid 2>/dev/null)" 2>/dev/null; true`));
}

// ---------- 清理其他面板 / 代理程序（不重装系统）----------
// 只认识下面这些常见的面板和代理程序，只删这里列出的服务和目录。默认彻底删除；勾选备份时整套（程序、配置、
// 服务文件、定时任务）打包到 /root/nodedeck-backup/<时间>/，之后可以在 NodeDeck 里一键恢复。
// detect：判断装没装用的路径（默认就是 paths）；markers：服务文件内容里出现这些目录也算它的服务；
// extraPaths：运行时才知道的路径（shell 片段，每行输出一个）；pre：删除前要做的事（shell 片段）
const OTHER_APPS = [
  { id: 'x-ui', name: 'x-ui / 3x-ui 面板', units: ['x-ui'], paths: ['/usr/local/x-ui', '/etc/x-ui', '/usr/bin/x-ui'] },
  { id: 's-ui', name: 's-ui 面板', units: ['s-ui'], paths: ['/usr/local/s-ui', '/usr/bin/s-ui'] },
  { id: 'h-ui', name: 'h-ui 面板', units: ['h-ui'], paths: ['/usr/local/h-ui'] },
  { id: 'xray', name: 'Xray', units: ['xray', 'xray@*'], paths: ['/usr/local/bin/xray', '/usr/local/etc/xray', '/usr/local/share/xray', '/var/log/xray', '/etc/xray', '/usr/local/xray'] },
  { id: 'v2ray', name: 'V2Ray', units: ['v2ray', 'v2ray@*'], paths: ['/usr/local/bin/v2ray', '/usr/local/bin/v2ctl', '/usr/local/etc/v2ray', '/usr/local/share/v2ray', '/var/log/v2ray', '/etc/v2ray', '/usr/bin/v2ray'] },
  { id: 'sing-box', name: 'sing-box（其他脚本装的）', units: ['sing-box', 'sing-box@*', 'sb'], paths: ['/usr/local/bin/sing-box', '/usr/bin/sing-box', '/etc/sing-box', '/usr/local/etc/sing-box', '/var/lib/sing-box', '/etc/s-box', '/root/sbox'], pkgs: ['sing-box'] },
  { id: 'hysteria', name: 'Hysteria / Hysteria2', units: ['hysteria-server', 'hysteria-server@*', 'hysteria', 'hysteria2'], paths: ['/usr/local/bin/hysteria', '/etc/hysteria', '/etc/hysteria2'] },
  { id: 'tuic', name: 'TUIC', units: ['tuic', 'tuic-server'], paths: ['/usr/local/bin/tuic', '/usr/local/bin/tuic-server', '/etc/tuic', '/opt/tuic', '/root/tuic'] },
  { id: 'trojan', name: 'Trojan / Trojan-Go', units: ['trojan-go', 'trojan'], paths: ['/usr/local/bin/trojan-go', '/usr/local/etc/trojan-go', '/etc/trojan-go', '/usr/local/bin/trojan', '/usr/local/etc/trojan'] },
  { id: 'ss-rust', name: 'shadowsocks-rust', units: ['shadowsocks-rust', 'ssserver', 'shadowsocks'], paths: ['/usr/local/bin/ssserver', '/usr/local/bin/sslocal', '/etc/shadowsocks-rust', '/etc/shadowsocks'] },
  { id: 'ss-libev', name: 'shadowsocks-libev', units: ['shadowsocks-libev', 'shadowsocks-libev-server@*'], paths: ['/etc/shadowsocks-libev'], pkgs: ['shadowsocks-libev'] },
  { id: 'gost', name: 'GOST 转发', units: ['gost'], paths: ['/usr/local/bin/gost', '/etc/gost'] },
  { id: 'realm', name: 'Realm 转发', units: ['realm'], paths: ['/usr/local/bin/realm', '/etc/realm', '/root/realm'] },
  { id: 'brook', name: 'Brook', units: ['brook'], paths: ['/usr/local/bin/brook', '/etc/brook'] },
  {
    id: 'bt', name: '宝塔面板', units: ['bt', 'btpanel'], markers: ['/www/server'], detect: ['/www/server/panel', '/etc/init.d/bt'],
    paths: ['/www', '/usr/bin/bt', '/etc/init.d/bt'], extraPaths: `grep -l '/www/server' /etc/my.cnf 2>/dev/null`,
    danger: '连同它装的 Nginx / MySQL / PHP 等，以及 /www 下的网站文件、数据库、宝塔备份一起删除',
  },
  {
    id: '1panel', name: '1Panel', units: ['1panel', '1panel-core', '1panel-agent'],
    paths: ['/usr/local/bin/1panel', '/usr/local/bin/1pctl', '/usr/local/bin/1panel-core', '/usr/local/bin/1panel-agent', '/usr/bin/1panel', '/usr/bin/1pctl', '/opt/1panel'],
    extraPaths: `B=$(sed -n 's/^BASE_DIR=//p' /usr/local/bin/1pctl /usr/bin/1pctl 2>/dev/null | head -1 | tr -d "\\"' "); [ -n "$B" ] && [ -d "$B/1panel" ] && echo "$B/1panel"`,
    pre: `if command -v docker >/dev/null; then for c in $(docker ps -aq --filter label=createdBy=1Panel 2>/dev/null); do docker rm -f -v "$c" >/dev/null 2>&1 && echo "  删除 1Panel 应用容器 $c"; done; docker network rm 1panel-network >/dev/null 2>&1; fi`,
    danger: '连同 1Panel 装的应用（Docker 容器）和网站数据一起删除；应用容器不会备份',
  },
  {
    id: 'hiddify', name: 'Hiddify Manager', units: ['hiddify-*'], markers: ['/opt/hiddify-manager'],
    paths: ['/opt/hiddify-manager', '/opt/hiddify-config', '/opt/hiddify-server'],
    danger: '它装的 Nginx、HAProxy、MariaDB、Redis 等系统软件包保留（别的程序可能也在用），它自己的服务和目录全部删除',
  },
];
// 不当作「其他程序」的系统 / 自己的进程
const SYSTEM_PROCS = /^(sshd|systemd|systemd-resolve|systemd-network|systemd-timesyn|chronyd|ntpd|dhclient|dhcpcd|rpcbind|nodedeck-agent|nodedeck-sing|docker-proxy|dockerd|containerd|master|exim4|postfix|cupsd|avahi-daemon|qemu-ga|cloud-init|snapd)$/;
const BACKUP_ROOT = '/root/nodedeck-backup';

function unitFileFn() {
  return [
    `unit_files() { for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do for f in "$d"/$1.service; do [ -f "$f" ] && echo "$f"; done; done; [ -f "/etc/init.d/$1" ] && echo "/etc/init.d/$1"; return 0; }`,
    // 内容里引用了某个目录的服务文件（宝塔装的 nginx / mysqld 等）
    `marker_units() { for f in /etc/systemd/system/*.service /usr/lib/systemd/system/*.service /lib/systemd/system/*.service /etc/init.d/*; do [ -f "$f" ] && grep -qs "$1" "$f" && echo "$f"; done; return 0; }`,
  ].join('\n');
}

async function scanOthers(server) {
  return withSSH(server, async (ssh) => {
    const lines = [unitFileFn()];
    for (const a of OTHER_APPS) {
      for (const u of a.units) lines.push(`for f in $(unit_files '${u}'); do n=$(basename "$f" .service); st=$( (systemctl is-active "$n" 2>/dev/null || rc-service "$n" status 2>/dev/null | grep -q started && echo active) | head -1); echo "U|${a.id}|$n|$st|$f"; done`);
      for (const p of a.detect || a.paths) lines.push(`[ -e ${shq(p)} ] && echo "D|${a.id}|${p}"`);
      for (const p of a.paths) lines.push(`[ -e ${shq(p)} ] && echo "P|${a.id}|${p}|$(du -sm ${shq(p)} 2>/dev/null | cut -f1)"`);
    }
    lines.push(`echo "---LISTEN"; (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null | tail -n +3)`);
    lines.push(`echo "---PIDS"; for p in $( (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null) | grep -o 'pid=[0-9]*\\|[0-9]*/' | tr -dc '0-9\\n' | sort -u); do [ -d /proc/$p ] || continue; echo "I|$p|$(readlink /proc/$p/exe 2>/dev/null)|$(grep -o '[^/]*\\.service' /proc/$p/cgroup 2>/dev/null | head -1)|$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-120)"; done`);
    // 备份：新格式（可恢复）和旧版留下的压缩包
    lines.push(`for d in ${BACKUP_ROOT}/*/; do [ -f "$d/meta.json" ] && echo "K|$(basename "$d")|$(du -sk "$d" | cut -f1)|$(tr -d '\\n' < "$d/meta.json")"; done; for f in /root/nodedeck-cleanup-*.tar.gz; do [ -f "$f" ] && echo "B|$f|$(du -k "$f" | cut -f1)"; done`);
    lines.push(`echo "---DOCKER"; command -v docker >/dev/null && docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null`);
    lines.push('true');
    const out = (await ssh.exec(lines.join('\n'), { timeout: 90000 })).stdout;
    const [head, rest1 = ''] = out.split('---LISTEN');
    const [listen, rest2 = ''] = rest1.split('---PIDS');
    const [pidsTxt, dockerTxt = ''] = rest2.split('---DOCKER');
    const procs = {};
    for (const l of pidsTxt.split('\n')) { const f = l.split('|'); if (f[0] === 'I') procs[f[1]] = { pid: f[1], exe: f[2] || '', unit: (f[3] || '').replace(/\.service$/, ''), cmd: (f[4] || '').trim() }; }
    // 监听端口：只看对外的（不含 127.0.0.1 / ::1）
    const ports = [];
    for (const l of listen.split('\n')) {
      const t = l.trim().split(/\s+/);
      if (t.length < 5) continue;
      const proto = /^udp/i.test(t[0]) ? 'udp' : 'tcp';
      const local = t.find((x, i) => i >= 3 && /:\d+$/.test(x)) || '';
      const m = local.match(/^(.*):(\d+)$/);
      if (!m || /^(127\.|\[?::1\]?|localhost)/.test(m[1])) continue;
      const pid = (l.match(/pid=(\d+)/) || l.match(/\s(\d+)\/\S+/) || [])[1];
      const pname = (l.match(/\(\("([^"]+)"/) || l.match(/\s\d+\/(\S+)/) || [])[1] || '';
      ports.push({ proto, port: Number(m[2]), pid, pname });
    }
    const portsOf = (pred) => [...new Set(ports.filter((p) => p.pid && procs[p.pid] && pred(procs[p.pid], p)).map((p) => `${p.port}/${p.proto}`))];
    const apps = [];
    for (const a of OTHER_APPS) {
      const units = []; const paths = []; let found = false;
      for (const l of head.split('\n')) {
        const f = l.split('|');
        if (f[1] !== a.id) continue;
        if (f[0] === 'U' && !units.some((u) => u.name === f[2])) units.push({ name: f[2], active: f[3] === 'active', file: f[4] });
        if (f[0] === 'D') found = true;
        if (f[0] === 'P') paths.push({ path: f[2], mb: Number(f[3]) || 0 });
      }
      if (!units.length && !found) continue;
      const unitNames = units.map((u) => u.name);
      const p = portsOf((pr) => unitNames.includes(pr.unit) || a.paths.some((x) => pr.exe && (pr.exe === x || pr.exe.startsWith(x + '/'))) || (a.markers || []).some((m) => pr.exe.startsWith(m + '/')));
      apps.push({ kind: 'app', id: a.id, name: a.name, danger: a.danger || '', units, paths, ports: p, running: units.some((u) => u.active) || p.length > 0, mb: paths.reduce((x, y) => x + y.mb, 0) });
    }
    const known = new Set(apps.flatMap((a) => a.units.map((u) => u.name)));
    const knownExe = (exe) => OTHER_APPS.some((a) => a.paths.concat(a.markers || []).some((x) => exe === x || exe.startsWith(x + '/')));
    const containers = dockerTxt.split('\n').map((l) => l.split('|')).filter((f) => f.length >= 4 && /^[0-9a-f]{6,}$/.test(f[0])).map((f) => ({ kind: 'docker', id: f[0], name: f[1], image: f[2], status: f[3], ports: f[4] || '', running: /^Up/i.test(f[3]) }));
    const others = new Map();
    for (const p of ports) {
      const pr = p.pid && procs[p.pid];
      const name = (pr && (pr.exe.split('/').pop() || p.pname)) || p.pname;
      if (!pr || SYSTEM_PROCS.test(p.pname) || SYSTEM_PROCS.test(name) || /nodedeck/.test(pr.exe + pr.unit) || pr.exe === SB_BIN) continue;
      if ((pr.unit && known.has(pr.unit)) || knownExe(pr.exe)) continue;
      if (/^(docker|containerd)/.test(pr.unit)) continue;
      const key = pr.unit || pr.exe || name;
      const o = others.get(key) || { kind: 'other', id: key, unit: pr.unit, exe: pr.exe, cmd: pr.cmd, name, ports: [] };
      const pp = `${p.port}/${p.proto}`;
      if (!o.ports.includes(pp)) o.ports.push(pp);
      others.set(key, o);
    }
    const backups = [];
    for (const l of out.split('\n')) {
      const f = l.split('|');
      if (f[0] === 'K' && /^\d{12,14}$/.test(f[1])) { let meta = {}; try { meta = JSON.parse(f.slice(3).join('|')); } catch (_) { /* ignore */ } backups.push({ id: f[1], kb: Number(f[2]) || 0, ...meta }); }
    }
    const oldBackups = out.split('\n').map((l) => l.split('|')).filter((f) => f[0] === 'B' && /^\/root\/nodedeck-cleanup-\d+\.tar\.gz$/.test(f[1])).map((f) => ({ path: f[1], kb: Number(f[2]) || 0 }));
    return { apps, containers, others: [...others.values()], backups: backups.sort((x, y) => (y.at || 0) - (x.at || 0)), oldBackups, at: Date.now() };
  });
}

function streamLog(log) {
  let buf = '';
  return { onData: (t) => { buf += t; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) log(line); } }, flush: () => { if (buf.trim()) log(buf.trim()); buf = ''; } };
}

// 删除选中的：items = [{ kind:'app', id } | { kind:'docker', id, image } | { kind:'other', unit } | { kind:'oldBackups' }]
// backup=true 时先把要删的程序整套打包，之后可以一键恢复
async function cleanOthers(server, items, log = () => {}, { backup: doBackup = false } = {}) {
  return withSSH(server, async (ssh) => {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const BK = `${BACKUP_ROOT}/${ts}`;
    const apps = items.filter((it) => it.kind === 'app').map((it) => OTHER_APPS.find((x) => x.id === it.id)).filter(Boolean);
    const sh = [unitFileFn(), 'set +e',
      'T=$(mktemp -d); : > $T/units; : > $T/paths',
      // 记下服务：名字|文件
      `note_unit() { n=$(basename "$1" .service); grep -qx "$n|$1" $T/units || echo "$n|$1" >> $T/units; }`,
      `stop_unit() { n="$1"; f="$2"; echo "  停止服务 $n"; case "$f" in /etc/init.d/*) "$f" stop >/dev/null 2>&1; update-rc.d -f "$n" remove >/dev/null 2>&1; chkconfig --del "$n" >/dev/null 2>&1; rc-update del "$n" >/dev/null 2>&1;; *) systemctl stop "$n" >/dev/null 2>&1; systemctl disable "$n" >/dev/null 2>&1;; esac; }`,
      `owned() { dpkg -S "$1" >/dev/null 2>&1 || rpm -qf "$1" >/dev/null 2>&1 || apk info -W "$1" >/dev/null 2>&1; }`,
      `safe_path() { case "$1" in /www|/usr/?*/?*|/usr/local/?*|/etc/?*|/opt/?*|/var/?*/?*|/root/?*|/www/?*) case "$1" in *nodedeck*|*..*) return 1;; esac; return 0;; esac; return 1; }`,
    ];
    // 第一步：找出每个程序的服务和路径
    const cronPats = [];
    sh.push(': > $T/bkonly');
    for (const a of apps) {
      sh.push(`echo "▶ ${a.name}"`);
      for (const u of a.units) sh.push(`for f in $(unit_files '${u}'); do note_unit "$f"; done`);
      for (const m of a.markers || []) sh.push(`for f in $(marker_units ${shq(m)}); do note_unit "$f"; done`);
      for (const p of a.paths) sh.push(`[ -e ${shq(p)} ] && echo ${shq(p)} >> $T/paths`);
      if (a.extraPaths) sh.push(`for p in $(${a.extraPaths}); do safe_path "$p" && [ -e "$p" ] && echo "$p" >> $T/paths; done`);
      cronPats.push(...a.paths.filter((x) => x !== '/www'), ...(a.markers || []));
    }
    const dockerItems = items.filter((it) => it.kind === 'docker' && /^[0-9a-f]{6,64}$/.test(it.id));
    const with1p = apps.some((a) => a.id === '1panel');
    const backingUp = doBackup && (apps.length || dockerItems.length);
    // 第二步（可选）：容器备份要在停服务、删容器之前做：配置（docker inspect）、数据卷、挂载目录、本地镜像
    if (backingUp && (dockerItems.length || with1p)) {
      sh.push(`mkdir -p ${BK}/docker && chmod 700 ${BACKUP_ROOT} ${BK}`,
        `bk_ctr() { c="$1"; n=$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null | tr -d '/'); [ -n "$n" ] || return 0; docker inspect "$c" > ${BK}/docker/ctr-$n.json; echo "  备份容器 $n"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$c"); do [ -f ${BK}/docker/vol-$v.tar.gz ] || { mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null); [ -n "$mp" ] && tar czf ${BK}/docker/vol-$v.tar.gz -C "$mp" . 2>/dev/null && echo "    数据卷 $v"; }; done
  for b in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} {{end}}{{end}}' "$c"); do [ -d "$b" ] && safe_path "$b" && echo "$b" >> $T/bkonly; done
  wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null); case "$wd" in /*) safe_path "$wd" && echo "$wd" >> $T/bkonly;; esac
  img=$(docker inspect -f '{{.Config.Image}}' "$c"); if [ "$(docker image inspect -f '{{len .RepoDigests}}' "$img" 2>/dev/null)" = "0" ]; then f=${BK}/docker/img-$(printf %s "$img" | tr -c 'A-Za-z0-9._-' '_').tar.gz; [ -f "$f" ] || { docker save "$img" | gzip > "$f" && echo "    本地镜像 $img"; }; fi; }`);
      for (const it of dockerItems) sh.push(`bk_ctr ${it.id}`);
      if (with1p) sh.push(`for c in $(docker ps -aq --filter label=createdBy=1Panel 2>/dev/null); do bk_ctr "$c"; done`);
    }
    // 停服务、做删除前的准备
    if (apps.length) sh.push(`while IFS='|' read -r n f; do [ -n "$n" ] && stop_unit "$n" "$f"; done < $T/units`);
    for (const a of apps) if (a.pre) sh.push(a.pre);
    // 第三步（可选）：程序整套打包
    if (backingUp) {
      const portsOf = (it) => (it.ports || []).filter((x) => /^\d{1,5}\/(tcp|udp)$/.test(x));
      const meta = {
        at: Date.now(), host: server.host,
        apps: apps.map((a) => ({ id: a.id, name: a.name, ports: portsOf(items.find((it) => it.kind === 'app' && it.id === a.id) || {}) })),
        containers: dockerItems.map((it) => String(it.name || it.id).replace(/[^\w.-]/g, '')).concat(with1p ? ['1Panel 的应用容器'] : []),
      };
      sh.push(`mkdir -p ${BK} && chmod 700 ${BACKUP_ROOT} ${BK}`,
        `{ cut -d'|' -f2 $T/units; cat $T/paths $T/bkonly; } | grep -v '^$' | sort -u | sed 's#^/##' > $T/list`,
        `echo "  打包备份（程序、配置、服务文件、数据目录）…"; if [ -s $T/list ]; then tar czf ${BK}/files.tar.gz -C / -T $T/list 2>/dev/null; else tar czf ${BK}/files.tar.gz -T /dev/null; fi; cp $T/units ${BK}/units.txt`,
        cronPats.length ? `crontab -l 2>/dev/null | grep -F ${[...new Set(cronPats)].map((x) => '-e ' + shq(x)).join(' ')} > ${BK}/cron.txt` : `: > ${BK}/cron.txt`,
        `printf '%s' ${shq(JSON.stringify(meta))} > ${BK}/meta.json`,
        `[ -f ${BK}/files.tar.gz ] && echo "备份完成：${BK}（$(du -sh ${BK} | cut -f1)），可以在 NodeDeck 里一键恢复" || echo "⚠ 备份失败"`);
    }
    // 第三步：删除服务文件、路径、软件包、定时任务
    if (apps.length) {
      sh.push(`while IFS='|' read -r n f; do [ -f "$f" ] || continue; if owned "$f"; then echo "  服务文件属于系统软件包，保留：$f"; else rm -f "$f" && echo "  删除服务文件 $f"; fi; done < $T/units`);
      sh.push(`sort -u $T/paths | while read -r p; do safe_path "$p" && [ -e "$p" ] && rm -rf "$p" && echo "  删除 $p"; done`);
      for (const a of apps) for (const pk of a.pkgs || []) sh.push(`if dpkg -s ${shq(pk)} >/dev/null 2>&1; then echo "  卸载软件包 ${pk}"; DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq ${shq(pk)} >/dev/null 2>&1; elif rpm -q ${shq(pk)} >/dev/null 2>&1; then yum remove -y -q ${shq(pk)} >/dev/null 2>&1; elif apk info -e ${shq(pk)} >/dev/null 2>&1; then apk del -q ${shq(pk)} >/dev/null 2>&1; fi`);
      if (cronPats.length) sh.push(`if crontab -l >$T/cron 2>/dev/null; then grep -v -F ${[...new Set(cronPats)].map((x) => '-e ' + shq(x)).join(' ')} $T/cron > $T/cron2; cmp -s $T/cron $T/cron2 || { crontab $T/cron2 && echo "  已清理相关的定时任务"; }; fi`);
    }
    for (const it of items) {
      if (it.kind === 'oldBackups') {
        sh.push('echo "▶ 删除旧版留下的备份"; for f in /root/nodedeck-cleanup-*.tar.gz; do [ -f "$f" ] && rm -f "$f" && echo "  删除 $f"; done');
      } else if (it.kind === 'docker' && /^[0-9a-f]{6,64}$/.test(it.id)) {
        const img = /^[\w./:@-]+$/.test(it.image || '') ? it.image : '';
        // 先记下它用的命名数据卷，删容器后没有别的容器在用就一起删
        sh.push(`echo "▶ 删除 Docker 容器 ${String(it.name || it.id).replace(/[^\w.-]/g, '')}"; vols=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' ${it.id} 2>/dev/null); docker rm -f -v ${it.id} >/dev/null 2>&1 && echo "  已删除容器" || echo "  删除失败"; for v in $vols; do docker volume rm "$v" >/dev/null 2>&1 && echo "  已删除数据卷 $v"; done${img ? `; docker image rm ${shq(img)} >/dev/null 2>&1 && echo "  已删除镜像 ${img}"` : ''}`);
      } else if (it.kind === 'other' && /^[\w@.:-]+$/.test(it.unit || '') && !/nodedeck|ssh|systemd|docker|containerd/.test(it.unit)) {
        sh.push(`echo "▶ 停用服务 ${it.unit}"; for f in $(unit_files ${shq(it.unit)}); do stop_unit ${shq(it.unit)} "$f"; done`);
      }
    }
    sh.push('rm -rf $T; systemctl daemon-reload >/dev/null 2>&1; systemctl reset-failed >/dev/null 2>&1; echo "完成"');
    const st = streamLog(log);
    const r = await ssh.exec(sh.join('\n'), { timeout: 1200000, onData: st.onData });
    st.flush();
    return { backup: /备份完成/.test(r.stdout) ? BK : '', output: r.stdout };
  }, { log });
}

// 恢复前读取备份内容和 VPS 当前占用的端口（用来提前解决端口冲突）
async function backupInfo(server, id) {
  if (!/^\d{12,14}$/.test(String(id))) throw new Error('备份编号不对');
  const BK = `${BACKUP_ROOT}/${id}`;
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`cat ${BK}/meta.json 2>/dev/null; echo; echo "---CTR"; for f in ${BK}/docker/ctr-*.json; do [ -f "$f" ] && { cat "$f"; echo "---SEP"; }; done; echo "---LISTEN"; (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null | tail -n +3); echo "---DOCKER"; command -v docker >/dev/null && echo yes`, { timeout: 60000 });
    const [metaTxt, rest = ''] = r.stdout.split('---CTR');
    const [ctrTxt, rest2 = ''] = rest.split('---LISTEN');
    const [listen, dockerTxt = ''] = rest2.split('---DOCKER');
    let meta = {};
    try { meta = JSON.parse(metaTxt.trim()); } catch (_) { throw new Error('读不到这份备份的信息，可能已经被删了'); }
    const containers = [];
    for (const part of ctrTxt.split('---SEP')) { try { const j = JSON.parse(part.trim()); if (Array.isArray(j) && j[0]) containers.push(j[0]); } catch (_) { /* ignore */ } }
    const busy = [];
    for (const l of listen.split('\n')) {
      const t = l.trim().split(/\s+/);
      if (t.length < 5) continue;
      const local = t.find((x, i) => i >= 3 && /:\d+$/.test(x)) || '';
      const m = local.match(/:(\d+)$/);
      if (!m) continue;
      const pname = (l.match(/\(\("([^"]+)"/) || l.match(/\s\d+\/(\S+)/) || [])[1] || '';
      busy.push({ port: Number(m[1]), proto: /^udp/i.test(t[0]) ? 'udp' : 'tcp', pname });
    }
    return { meta, containers, busy, docker: /yes/.test(dockerTxt) };
  });
}

// 按 docker inspect 的结果重新生成 docker run（remap：{ '主机端口/协议': 新端口 }）
function dockerRunCmd(ins, remap = {}) {
  const c = ins.Config || {}; const hc = ins.HostConfig || {};
  const a = ['docker run -d', '--name ' + shq(String(ins.Name || '').replace(/^\//, ''))];
  const rp = hc.RestartPolicy || {};
  if (rp.Name && rp.Name !== 'no') a.push('--restart ' + (rp.Name === 'on-failure' && rp.MaximumRetryCount ? `on-failure:${rp.MaximumRetryCount}` : rp.Name));
  const net = hc.NetworkMode;
  if (net && !['default', 'bridge'].includes(net)) a.push('--network ' + shq(net));
  if (net !== 'host') {
    for (const [cp, binds] of Object.entries(hc.PortBindings || {})) {
      const proto = cp.split('/')[1] || 'tcp';
      for (const b of binds || []) {
        const hp = remap[`${b.HostPort}/${proto}`] || b.HostPort;
        const ip = b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? (b.HostIp.includes(':') ? `[${b.HostIp}]:` : `${b.HostIp}:`) : '';
        a.push('-p ' + shq(`${ip}${hp ? hp + ':' : ''}${cp}`));
      }
    }
  }
  for (const e of c.Env || []) a.push('-e ' + shq(e));
  for (const m of ins.Mounts || []) {
    const ro = m.RW === false ? ':ro' : '';
    if (m.Type === 'volume' && m.Name) a.push('-v ' + shq(`${m.Name}:${m.Destination}${ro}`));
    else if (m.Type === 'bind') a.push('-v ' + shq(`${m.Source}:${m.Destination}${ro}`));
  }
  if (hc.Privileged) a.push('--privileged');
  for (const x of hc.CapAdd || []) a.push('--cap-add ' + shq(x));
  for (const d of hc.Devices || []) a.push('--device ' + shq(`${d.PathOnHost}:${d.PathInContainer}`));
  for (const x of hc.ExtraHosts || []) a.push('--add-host ' + shq(x));
  for (const [k, v] of Object.entries(c.Labels || {})) if (!k.startsWith('com.docker.compose')) a.push('--label ' + shq(`${k}=${v}`));
  if (c.WorkingDir) a.push('-w ' + shq(c.WorkingDir));
  if (c.User) a.push('-u ' + shq(c.User));
  const ep = c.Entrypoint || [];
  let cmd = c.Cmd || [];
  if (ep.length) { a.push('--entrypoint ' + shq(ep[0])); cmd = [...ep.slice(1), ...cmd]; }
  a.push(shq(c.Image));
  for (const x of cmd) a.push(shq(x));
  return a.join(' ');
}

// 一键恢复：解压回原位置、恢复定时任务、重新启用并启动服务；容器按备份重新创建（端口冲突的按 remap 换端口）
async function restoreBackup(server, id, log = () => {}, { containers = [], remap = {} } = {}) {
  if (!/^\d{12,14}$/.test(String(id))) throw new Error('备份编号不对');
  const BK = `${BACKUP_ROOT}/${id}`;
  return withSSH(server, async (ssh) => {
    const sh = ['set +e',
      `[ -f ${BK}/files.tar.gz ] || { echo "找不到备份文件"; exit 1; }`,
      `echo "▶ 解压程序、配置和数据到原来的位置…"; tar xzf ${BK}/files.tar.gz -C / && echo "  完成"`,
      `if [ -s ${BK}/cron.txt ]; then T=$(mktemp); crontab -l 2>/dev/null > $T; while IFS= read -r l; do grep -qxF "$l" $T || echo "$l" >> $T; done < ${BK}/cron.txt; crontab $T && echo "  定时任务已恢复"; rm -f $T; fi`,
      'systemctl daemon-reload >/dev/null 2>&1',
      `[ -f ${BK}/units.txt ] && while IFS='|' read -r n f; do [ -n "$n" ] || continue; case "$f" in /etc/init.d/*) (update-rc.d "$n" defaults >/dev/null 2>&1 || chkconfig --add "$n" >/dev/null 2>&1 || rc-update add "$n" default >/dev/null 2>&1); "$f" start >/dev/null 2>&1;; *) systemctl enable "$n" >/dev/null 2>&1; systemctl start "$n" >/dev/null 2>&1;; esac; echo "  启动服务 $n"; done < ${BK}/units.txt`,
    ];
    if (containers.length) {
      sh.push('echo "▶ 恢复 Docker 容器"',
        // 没有 Docker 就先装上（官方安装脚本）
        `if ! command -v docker >/dev/null; then echo "  VPS 上没有 Docker，正在安装（官方脚本，约 1–3 分钟）…"; curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || wget -qO- https://get.docker.com | sh >/dev/null 2>&1; systemctl enable --now docker >/dev/null 2>&1; command -v docker >/dev/null && echo "  Docker 已安装" || { echo "  ✗ Docker 安装失败，容器没法恢复"; exit 2; }; fi`,
        `for f in ${BK}/docker/img-*.tar.gz; do [ -f "$f" ] && gunzip -c "$f" | docker load >/dev/null 2>&1 && echo "  导入本地镜像 $(basename "$f")"; done`,
        `for f in ${BK}/docker/vol-*.tar.gz; do [ -f "$f" ] || continue; v=$(basename "$f" .tar.gz); v=\${v#vol-}; docker volume create "$v" >/dev/null 2>&1; mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null); [ -n "$mp" ] && tar xzf "$f" -C "$mp" && echo "  数据卷 $v"; done`);
      const projects = new Set();
      for (const ins of containers) {
        const name = String(ins.Name || '').replace(/^\//, '').replace(/[^\w.-]/g, '');
        const wd = ins.Config?.Labels?.['com.docker.compose.project.working_dir'];
        if (wd && /^\/[\w./@-]+$/.test(wd)) {
          // docker compose 部署的：用原来的项目目录整体拉起（目录已经随备份恢复）
          if (projects.has(wd)) continue;
          projects.add(wd);
          sh.push(`if [ -d ${shq(wd)} ]; then cd ${shq(wd)} && { docker compose up -d >/dev/null 2>&1 || docker-compose up -d >/dev/null 2>&1; } && echo "  compose 项目 ${wd} 已启动" || echo "  ✗ compose 项目 ${wd} 启动失败"; cd /; fi`);
          continue;
        }
        const net = ins.HostConfig?.NetworkMode;
        if (net && !['default', 'bridge', 'host', 'none'].includes(net) && !/^container:/.test(net)) sh.push(`docker network inspect ${shq(net)} >/dev/null 2>&1 || docker network create ${shq(net)} >/dev/null 2>&1`);
        const img = ins.Config?.Image || '';
        sh.push(`docker image inspect ${shq(img)} >/dev/null 2>&1 || { echo "  下载镜像 ${img.replace(/[^\w./:@-]/g, '')} …"; docker pull ${shq(img)} >/dev/null 2>&1; }`,
          `docker rm -f ${shq(name)} >/dev/null 2>&1; ${dockerRunCmd(ins, remap)} >/dev/null 2>&1 && echo "  容器 ${name} 已启动" || echo "  ✗ 容器 ${name} 启动失败"`);
      }
    }
    sh.push('echo "恢复完成"');
    const st = streamLog(log);
    const r = await ssh.exec(sh.join('\n'), { timeout: 1800000, onData: st.onData });
    st.flush();
    if (r.code !== 0 && !/恢复完成/.test(r.stdout)) throw new Error((r.stdout + r.stderr).trim().split('\n').pop() || '恢复失败');
    return true;
  }, { log });
}

async function deleteBackup(server, id) {
  if (!/^\d{12,14}$/.test(String(id))) throw new Error('备份编号不对');
  return withSSH(server, (ssh) => ssh.run(`rm -rf ${BACKUP_ROOT}/${id}; rmdir ${BACKUP_ROOT} 2>/dev/null; true`));
}

// BBR 和 CUBIC 对比：交替切换拥塞控制，各测几轮下载速度（由调用方测），最后恢复原来的设置
async function withCC(server, fn) {
  return withSSH(server, async (ssh) => fn({ setCC: (cc) => netSetCC(ssh, cc), tcp: () => netTcp(ssh), info: () => agentJSON(ssh, `net-info -c ${DIR}/agent.json`) }));
}

// 「重新优选 Reality 目标」
async function pickReality(server, log = () => {}) {
  return withSSH(server, (ssh) => pickRealityOn(ssh, server, log));
}

// 让 VPS 代发一条 Telegram（被墙检测等桌面端发现的问题）
async function adminNotify(server, text) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`${AGENT_BIN} notify -c ${DIR}/agent.json -text ${shq(text)}`);
    if (r.code !== 0) throw new Error((r.stdout || r.stderr).trim());
    return true;
  });
}

// 立即检查一次 Reality 目标
async function realityCheck(server) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`${AGENT_BIN} reality-check -c ${DIR}/agent.json`, { timeout: 120000 });
    try { return JSON.parse(r.stdout); } catch (_) { throw new Error((r.stdout || r.stderr || '检查失败').trim()); }
  });
}

// 在 VPS 上检测 Reality 目标（agent check-reality，标准和本机检测一致）。
// Reality 是 VPS 去连目标网站，所以能不能用以 VPS 的结果为准
async function vpsCheckTarget(ssh, domain) {
  const d = String(domain).replace(/[^a-zA-Z0-9.-]/g, '');
  const r = await ssh.exec(`${AGENT_BIN} check-reality -domains ${shq(d)}`, { timeout: 60000 });
  let list;
  try { list = JSON.parse(r.stdout); } catch (_) { list = null; }
  if (!Array.isArray(list) || !list[0]) throw new Error('VPS 上的 agent 太旧，不支持目标检测，先点「同步」升级 agent');
  return { ...list[0], where: 'vps', at: Date.now() };
}

async function remoteTlsCheck(server, domain) {
  return withSSH(server, (ssh) => vpsCheckTarget(ssh, domain));
}

const CHECK_TTL = 24 * 3600e3;

// 固定 Reality 目标的部署前检测：部署时、或目标和上次部署的不一样时，必须在 VPS 上检测通过（24 小时内通过的结果可沿用）。
// 自动优选的目标在挑选时已经检测过，这里不管。
async function gateRealityTarget(ssh, server, log, force) {
  const rp = server.protocols?.vlessReality;
  if (!rp?.enabled || rp.sniAuto) return;
  if (!force && rp.sniDeployed === rp.sni) return;
  const c = rp.sniCheck;
  if (c && c.where === 'vps' && c.domain === rp.sni && c.ok && Date.now() - c.at < CHECK_TTL) {
    log(`Reality 目标 ${rp.sni}：${new Date(c.at).toLocaleString('zh-CN')} 在 VPS 上检测通过，沿用`);
    return;
  }
  log(`在 VPS 上检测 Reality 目标 ${rp.sni} …`);
  const r = await vpsCheckTarget(ssh, rp.sni);
  rp.sniCheck = { domain: r.domain, ok: r.ok, at: r.at, ms: r.ms, checks: r.checks, error: r.error, where: 'vps' };
  if (!r.ok) {
    const detail = (r.checks || []).filter((x) => !x.ok).map((x) => `${x.name}（${x.value}）`).join('、') || r.error;
    throw new Error(`Reality 目标 ${rp.sni} 在 VPS 上检测不通过：${detail}。请换一个目标，或改成「自动优选」`);
  }
  log(`✔ Reality 目标 ${rp.sni} 检测通过（TLS 1.3、HTTP/2、X25519、证书有效，${r.ms} ms）`);
}

module.exports = { OTHER_APPS, scanOthers, cleanOthers, backupInfo, dockerRunCmd, restoreBackup, deleteBackup, netPing, netInfo, netTune, netRestore, netTrace, netMtu, withCC, benchStart, benchPoll, benchStop, swapSize, memLimits, writeUnits, tuneSmallBox, rememberHw, pickReality, adminNotify, realityCheck, deployServer, syncServer, updateSingbox, serverSelfCheck, notifyTest, fetchMetrics, scanReality, serverStatus, fetchStats, resetTraffic, serverLogs, uninstall, testSSH, remoteTlsCheck, agentConfig };
