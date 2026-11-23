'use strict';
// 通过 SSH 在 VPS 上安装 / 同步 / 卸载 NodeDeck（sing-box + agent）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');
const { withSSH, shq } = require('./ssh');
const QRCode = require('qrcode');

const DIR = core.REMOTE_DIR;
const SB_BIN = '/usr/local/bin/nodedeck-sing-box';
const AGENT_BIN = '/usr/local/bin/nodedeck-agent';

const SB_UNIT = `[Unit]
Description=NodeDeck sing-box
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${SB_BIN} run -c ${DIR}/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;

const AGENT_UNIT = `[Unit]
Description=NodeDeck agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${AGENT_BIN} run -c ${DIR}/agent.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;

const OPENRC_SB = `#!/sbin/openrc-run
name="nodedeck-singbox"
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

const OPENRC_AGENT = `#!/sbin/openrc-run
name="nodedeck-agent"
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
  if (!j.domain) { log('⚠ 没找到合适的 Reality 目标，继续用 ' + server.protocols.vlessReality.sni); return null; }
  return { domain: j.domain, source: j.source };
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
`);
  const kv = {};
  for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return kv;
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
    if (info.ARCH === 'unsupported') throw new Error('不支持的 CPU 架构');
    if (info.INIT === 'none') throw new Error('系统既没有 systemd 也没有 OpenRC，暂不支持');
    server.initSystem = info.INIT;

    log('§agent');
    log('上传 agent …');
    await ssh.run(`mkdir -p ${DIR} && chmod 700 ${DIR}`);
    await ssh.writeGz(AGENT_BIN, agentGz(resourcesDir, info.ARCH));

    const manifest = agentConfig(state).singboxManifest;
    log('§kernel');
    log(`安装 sing-box（${manifest}）…`);
    const v = await ssh.run(`${AGENT_BIN} install-singbox -manifest ${shq(manifest)} -bin ${SB_BIN}`);
    log(v.trim() + '（已校验 sha256）');

    log('生成自签证书 …');
    const sni = server.tlsSni || 'www.bing.com';
    await ssh.run(`
if [ ! -f ${DIR}/cert.pem ] || [ "$(cat ${DIR}/cert.sni 2>/dev/null)" != ${shq(sni)} ]; then
  ${AGENT_BIN} gencert -host ${shq(sni)} -dir ${DIR} && printf %s ${shq(sni)} > ${DIR}/cert.sni
fi`);

    await ssh.writeFile(`${DIR}/agent.json`, JSON.stringify(agentConfig(state, server), null, 2));
    if (server.initSystem === 'openrc') {
      await ssh.writeFile('/etc/init.d/nodedeck-singbox', OPENRC_SB, '755');
      await ssh.writeFile('/etc/init.d/nodedeck-agent', OPENRC_AGENT, '755');
    } else {
      await ssh.writeFile('/etc/systemd/system/nodedeck-singbox.service', SB_UNIT, '644');
      await ssh.writeFile('/etc/systemd/system/nodedeck-agent.service', AGENT_UNIT, '644');
    }

    log('开启 BBR、放行防火墙端口 …');
    await ssh.run(`
grep -q nodedeck-bbr /etc/sysctl.conf 2>/dev/null || printf '\\n# nodedeck-bbr\\nnet.core.default_qdisc=fq\\nnet.ipv4.tcp_congestion_control=bbr\\n' >> /etc/sysctl.conf
sysctl -p >/dev/null 2>&1 || true`);
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
        Object.assign(rp, { sni: pick.domain, sniSource: pick.source, sniPickedAt: Date.now() });
        log(`✔ Reality 目标：${pick.domain}（${pick.source === 'neighbor' ? '同网段邻居' : '备选大站里最快的'}）`);
      }
    }
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
      if (j.override && j.from === rp.sni) { log(`Reality 目标已被 VPS 自动换成 ${j.override}（原 ${rp.sni} 不可用），同步到本地`); Object.assign(rp, { sni: j.override, sniSource: 'patrol', sniPickedAt: (j.changedAt || 0) * 1000 }); }
    } catch (_) { /* ignore */ }
  }
  // 记下自签证书的指纹，分享链接里要带上（新版 v2rayNG 不再支持跳过证书验证）
  try {
    const pem = (await ssh.exec(`cat ${DIR}/cert.pem 2>/dev/null`)).stdout;
    if (pem.includes('BEGIN CERTIFICATE')) server.certSha256 = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
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
echo IP6=$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/{print $2}' | cut -d/ -f1 | grep -v '^f[cd]' | head -1)
`);
  const kv = {};
  for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return { singbox: kv.SB === 'active', agent: kv.AG === 'active', version: kv.VER || '', agentVersion: kv.AGV || '', cf: kv.CF === 'active', ipv6: kv.IP6 || '', load: kv.LOAD, mem: kv.MEM, uptime: kv.UP };
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
    const agv = (await ssh.exec(`${AGENT_BIN} version`)).stdout.trim();
    if (resourcesDir && appVersion && agv !== appVersion) {
      const info = await detect(ssh);
      log(`升级 agent ${agv || '?'} → ${appVersion}`);
      await ssh.writeGz(AGENT_BIN, agentGz(resourcesDir, info.ARCH));
      restart = true;
    }
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
${svcOf(server).remove}
rm -f ${AGENT_BIN} ${SB_BIN} ${SB_BIN}.old ${SB_BIN}.bad
rm -rf ${DIR}
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

async function remoteTlsCheck(server, domain) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`curl -so /dev/null --tlsv1.3 --http2 -w '%{time_connect} %{time_appconnect} %{http_version}' --connect-timeout 8 https://${domain.replace(/[^a-zA-Z0-9.-]/g, '')}/`, { root: false });
    const [tc, ta, hv] = r.stdout.trim().split(' ');
    return { ok: r.code === 0, connectMs: Math.round(Number(tc) * 1000), tlsMs: Math.round(Number(ta) * 1000), http: hv, error: r.code !== 0 ? (r.stderr || '失败（可能不支持 TLS1.3 / HTTP2）') : '' };
  });
}

module.exports = { pickReality, adminNotify, realityCheck, deployServer, syncServer, updateSingbox, serverSelfCheck, notifyTest, fetchMetrics, scanReality, serverStatus, fetchStats, resetTraffic, serverLogs, uninstall, testSSH, remoteTlsCheck, agentConfig };
