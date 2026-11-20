'use strict';
// 通过 SSH 在 VPS 上安装 / 同步 / 卸载 NodeDeck（sing-box + agent）
const fs = require('fs');
const path = require('path');
const core = require('./core');
const { withSSH, shq } = require('./ssh');

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

function agentConfig(state) {
  const st = state.settings || {};
  return {
    statsApi: `127.0.0.1:${st.statsPort || 9092}`,
    subListen: `:${st.subPort || 2096}`,
    adminListen: `127.0.0.1:${st.adminPort || 9091}`,
    dataDir: DIR,
    singbox: SB_BIN,
    service: 'nodedeck-singbox',
  };
}

function agentGz(resourcesDir, arch) {
  const f = path.join(resourcesDir, 'agent', `nodedeck-agent-linux-${arch}.gz`);
  if (!fs.existsSync(f)) throw new Error(`缺少 agent 文件：${f}（请用 GitHub Actions 构建的安装包，或先运行 scripts/build-agent.sh）`);
  return fs.readFileSync(f);
}

function singboxUrl(state, arch) {
  const tpl = state.settings?.singboxUrl || '';
  return tpl.replace(/\{arch\}/g, arch);
}

async function detect(ssh) {
  const out = await ssh.run(`
set -e
case "$(uname -m)" in x86_64|amd64) echo ARCH=amd64;; aarch64|arm64) echo ARCH=arm64;; *) echo ARCH=unsupported;; esac
command -v systemctl >/dev/null && echo SYSTEMD=1 || echo SYSTEMD=0
command -v curl >/dev/null && echo CURL=1 || echo CURL=0
command -v wget >/dev/null && echo WGET=1 || echo WGET=0
. /etc/os-release 2>/dev/null && echo "OS=$PRETTY_NAME" || echo OS=unknown
`);
  const kv = {};
  for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return kv;
}

// 完整部署：安装依赖、sing-box、agent、证书、systemd、防火墙，然后同步配置
async function deployServer(state, server, { resourcesDir, log }) {
  const errs = core.checkPortConflicts(state, server);
  if (errs.length) throw new Error(errs.join('；'));
  return withSSH(server, async (ssh) => {
    log(`已连接 ${server.host}`);
    if (ssh.sudo) {
      const r = await ssh.exec('true');
      if (r.code !== 0) throw new Error('当前用户无法免密 sudo，请使用 root 或配置 NOPASSWD');
    }
    const info = await detect(ssh);
    log(`系统：${info.OS}，架构：${info.ARCH}`);
    if (info.ARCH === 'unsupported') throw new Error('不支持的 CPU 架构');
    if (info.SYSTEMD !== '1') throw new Error('系统没有 systemd，暂不支持');

    if (info.CURL !== '1' && info.WGET !== '1') {
      log('安装 curl …');
      await ssh.run('(command -v apt-get && apt-get update -y && apt-get install -y curl) || (command -v dnf && dnf install -y curl) || (command -v yum && yum install -y curl) || (command -v apk && apk add curl)', { onData: () => {} });
    }

    // sing-box（带 v2ray_api 的构建，从你的 GitHub Release 下载）
    const url = singboxUrl(state, info.ARCH);
    log(`下载 sing-box：${url}`);
    await ssh.run(`
set -e
mkdir -p ${DIR}; chmod 700 ${DIR}
TMP=$(mktemp)
if command -v curl >/dev/null; then curl -fsSL --retry 3 --connect-timeout 15 -o "$TMP" ${shq(url)}; else wget -q -O "$TMP" ${shq(url)}; fi
gunzip -c "$TMP" > ${SB_BIN}.tmp && chmod 755 ${SB_BIN}.tmp && rm -f "$TMP"
${SB_BIN}.tmp version | grep -q with_v2ray_api || { echo "下载的 sing-box 不含 with_v2ray_api"; exit 1; }
mv -f ${SB_BIN}.tmp ${SB_BIN}
${SB_BIN} version | head -1
`, { onData: (t) => log(t.trim()) });

    log('上传 agent …');
    await ssh.writeGz(AGENT_BIN, agentGz(resourcesDir, info.ARCH));

    log('生成自签证书 …');
    const sni = server.tlsSni || 'www.bing.com';
    await ssh.run(`
if [ ! -f ${DIR}/cert.pem ] || [ "$(cat ${DIR}/cert.sni 2>/dev/null)" != ${shq(sni)} ]; then
  ${AGENT_BIN} gencert -host ${shq(sni)} -dir ${DIR} && printf %s ${shq(sni)} > ${DIR}/cert.sni
fi`);

    await ssh.writeFile(`${DIR}/agent.json`, JSON.stringify(agentConfig(state), null, 2));
    await ssh.writeFile('/etc/systemd/system/nodedeck-singbox.service', SB_UNIT, '644');
    await ssh.writeFile('/etc/systemd/system/nodedeck-agent.service', AGENT_UNIT, '644');

    log('开启 BBR、放行防火墙端口 …');
    const ports = core.serverPorts(state, server);
    const fw = ports.map(({ port, net }) => {
      const nets = net === 'both' || !net ? ['tcp', 'udp'] : [net];
      return nets.map((n) => `ufw allow ${port}/${n} >/dev/null 2>&1 || true; firewall-cmd -q --permanent --add-port=${port}/${n} 2>/dev/null || true`).join('; ');
    }).join('\n');
    await ssh.run(`
grep -q nodedeck-bbr /etc/sysctl.conf 2>/dev/null || printf '\\n# nodedeck-bbr\\nnet.core.default_qdisc=fq\\nnet.ipv4.tcp_congestion_control=bbr\\n' >> /etc/sysctl.conf
sysctl -p >/dev/null 2>&1 || true
if command -v ufw >/dev/null && ufw status | grep -q active; then UFW=1; fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then FWD=1; fi
${fw}
[ -n "$FWD" ] && firewall-cmd -q --reload || true
true`);

    await pushConfig(ssh, state, server, log);
    await ssh.run('systemctl daemon-reload && systemctl enable nodedeck-singbox nodedeck-agent >/dev/null 2>&1');
    await ssh.run('systemctl restart nodedeck-agent');
    await new Promise((r) => setTimeout(r, 2500));
    const st = await status(ssh);
    if (!st.singbox || !st.agent) {
      const j = await ssh.exec('journalctl -u nodedeck-singbox -u nodedeck-agent -n 30 --no-pager');
      throw new Error('服务未正常启动：\n' + j.stdout);
    }
    log('部署完成 ✔');
    return st;
  });
}

async function pushConfig(ssh, state, server, log = () => {}) {
  const full = core.buildServerConfig(state, server);
  await ssh.writeFile(`${DIR}/config.full.json`, JSON.stringify(full, null, 2));
  await ssh.writeFile(`${DIR}/users.json`, JSON.stringify(core.buildAgentUsers(state, server)));
  await ssh.writeFile(`${DIR}/subs.json`, JSON.stringify(core.buildAgentSubs(state, server)));
  // 校验
  const r = await ssh.exec(`${SB_BIN} check -c ${DIR}/config.full.json`);
  if (r.code !== 0) throw new Error('sing-box 配置校验失败：' + (r.stderr || r.stdout));
  log('配置已上传');
}

async function status(ssh) {
  const r = await ssh.exec(`
echo SB=$(systemctl is-active nodedeck-singbox 2>/dev/null)
echo AG=$(systemctl is-active nodedeck-agent 2>/dev/null)
echo VER=$(${SB_BIN} version 2>/dev/null | head -1 | awk '{print $3}')
echo LOAD=$(cut -d' ' -f1-3 /proc/loadavg)
echo MEM=$(free -m | awk '/Mem:/{print $3"/"$2"MB"}')
echo UP=$(uptime -p 2>/dev/null)
`);
  const kv = {};
  for (const line of r.stdout.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  return { singbox: kv.SB === 'active', agent: kv.AG === 'active', version: kv.VER || '', load: kv.LOAD, mem: kv.MEM, uptime: kv.UP };
}

async function syncServer(state, server, { log = () => {} } = {}) {
  return withSSH(server, async (ssh) => {
    await pushConfig(ssh, state, server, log);
    const r = await ssh.exec(`${AGENT_BIN} apply -c ${DIR}/agent.json`);
    if (r.code !== 0) {
      // agent 可能没在跑，尝试重启
      await ssh.run('systemctl restart nodedeck-agent');
      await new Promise((res) => setTimeout(res, 2500));
    }
    return status(ssh);
  });
}

async function serverStatus(server) { return withSSH(server, status); }

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
  return withSSH(server, async (ssh) => (await ssh.exec('journalctl -u nodedeck-singbox -u nodedeck-agent -n 120 --no-pager')).stdout);
}

async function uninstall(server) {
  return withSSH(server, (ssh) => ssh.run(`
systemctl disable --now nodedeck-agent nodedeck-singbox >/dev/null 2>&1 || true
rm -f /etc/systemd/system/nodedeck-agent.service /etc/systemd/system/nodedeck-singbox.service ${AGENT_BIN} ${SB_BIN}
rm -rf ${DIR}
systemctl daemon-reload
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

// 在服务器上测试 Reality 目标域名（延迟应尽量低）
async function remoteTlsCheck(server, domain) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`curl -so /dev/null --tlsv1.3 --http2 -w '%{time_connect} %{time_appconnect} %{http_version}' --connect-timeout 8 https://${domain.replace(/[^a-zA-Z0-9.-]/g, '')}/`, { root: false });
    const [tc, ta, hv] = r.stdout.trim().split(' ');
    return { ok: r.code === 0, connectMs: Math.round(Number(tc) * 1000), tlsMs: Math.round(Number(ta) * 1000), http: hv, error: r.code !== 0 ? (r.stderr || '失败（可能不支持 TLS1.3 / HTTP2）') : '' };
  });
}

module.exports = { deployServer, syncServer, serverStatus, fetchStats, resetTraffic, serverLogs, uninstall, testSSH, remoteTlsCheck, agentConfig };
