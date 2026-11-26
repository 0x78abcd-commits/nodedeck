'use strict';
// VPS 上的文件位置、服务文件（systemd / OpenRC）模板，以及调用 agent 命令的小工具
const core = require('./core');

const DIR = core.REMOTE_DIR;
const SB_BIN = '/usr/local/bin/nodedeck-sing-box';
const AGENT_BIN = '/usr/local/bin/nodedeck-agent';
const XRAY_BIN = '/usr/local/bin/nodedeck-xray';

// 小内存机器的内存上限（Go 运行时的 GOMEMLIMIT）：流量高峰过后把多占的内存还给系统。
// 实测 sing-box 空闲约 40MB，每个正在传数据的连接约 0.5–0.8MB；agent 约 10MB。
// 2GB 以上的机器不设，按 Go 默认行为
function memLimits(memMB) {
  if (!memMB || memMB > 2048) return { sb: '', agent: '', xr: '' };
  return { sb: `${Math.max(128, Math.floor(memMB * 0.5))}MiB`, agent: '48MiB', xr: `${Math.max(96, Math.floor(memMB * 0.25))}MiB` };
}

// Xray（只在开了 XHTTP 协议时装）：xray.json 由 agent 生成，没有就不启动
function xrayUnit(lim = {}) {
  return `[Unit]
Description=NodeDeck Xray (XHTTP)
After=network-online.target nodedeck-singbox.service
Wants=network-online.target
ConditionPathExists=${DIR}/xray.json

[Service]
ExecStart=${XRAY_BIN} run -c ${DIR}/xray.json
Restart=always
RestartSec=3
LimitNOFILE=1048576
${lim.xr ? `Environment=GOMEMLIMIT=${lim.xr}
` : ''}LogRateLimitIntervalSec=30s
LogRateLimitBurst=200

[Install]
WantedBy=multi-user.target
`;
}

const openrcXray = (lim = {}) => `#!/sbin/openrc-run
${lim.xr ? `export GOMEMLIMIT=${lim.xr}\n` : ''}name="nodedeck-xray"
description="NodeDeck Xray (XHTTP)"
command="${XRAY_BIN}"
command_args="run -c ${DIR}/xray.json"
supervisor="supervise-daemon"
respawn_delay=3
respawn_max=0
output_log="/var/log/nodedeck-xray.log"
error_log="/var/log/nodedeck-xray.log"
rc_ulimit="-n 1048576"
depend() { need net; after nodedeck-singbox; }
start_pre() { [ -f ${DIR}/xray.json ] || { eerror "没有 ${DIR}/xray.json"; return 1; }; }
`;

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
    logs: 'journalctl -u nodedeck-singbox -u nodedeck-agent -u nodedeck-cf -u nodedeck-xray -n 120 --no-pager',
    xrOn: (unit) => `cat > /etc/systemd/system/nodedeck-xray.service <<'NDEOF'\n${unit}NDEOF\nsystemctl daemon-reload && systemctl enable nodedeck-xray >/dev/null 2>&1; true`,
    xrOff: 'if [ -f /etc/systemd/system/nodedeck-xray.service ]; then systemctl disable --now nodedeck-xray >/dev/null 2>&1; rm -f /etc/systemd/system/nodedeck-xray.service; systemctl daemon-reload; fi; true',
    xrUnitFile: '/etc/systemd/system/nodedeck-xray.service',
    cfOn: (unit) => `cat > /etc/systemd/system/nodedeck-cf.service <<'NDEOF'\n${unit}NDEOF\nsystemctl daemon-reload && systemctl enable nodedeck-cf >/dev/null 2>&1; systemctl restart nodedeck-cf`,
    cfOff: 'if [ -f /etc/systemd/system/nodedeck-cf.service ]; then systemctl disable --now nodedeck-cf >/dev/null 2>&1; rm -f /etc/systemd/system/nodedeck-cf.service; systemctl daemon-reload; fi; true',
    remove: `systemctl disable --now nodedeck-agent nodedeck-singbox nodedeck-cf nodedeck-xray >/dev/null 2>&1 || true
rm -f /etc/systemd/system/nodedeck-agent.service /etc/systemd/system/nodedeck-singbox.service /etc/systemd/system/nodedeck-cf.service /etc/systemd/system/nodedeck-xray.service
systemctl daemon-reload`,
  },
  openrc: {
    install: 'rc-update add nodedeck-singbox default >/dev/null 2>&1; rc-update add nodedeck-agent default >/dev/null 2>&1; true',
    restartAgent: 'rc-service nodedeck-agent restart',
    restartSb: 'rc-service nodedeck-singbox restart',
    active: (n) => `rc-service ${n} status >/dev/null 2>&1 && echo active || echo inactive`,
    logs: 'tail -n 60 /var/log/nodedeck-singbox.log /var/log/nodedeck-agent.log /var/log/nodedeck-cf.log /var/log/nodedeck-xray.log 2>/dev/null',
    xrOn: (unit) => `cat > /etc/init.d/nodedeck-xray <<'NDEOF'\n${unit}NDEOF\nchmod 755 /etc/init.d/nodedeck-xray; rc-update add nodedeck-xray default >/dev/null 2>&1; true`,
    xrOff: 'if [ -f /etc/init.d/nodedeck-xray ]; then rc-service nodedeck-xray stop >/dev/null 2>&1; rc-update del nodedeck-xray default >/dev/null 2>&1; rm -f /etc/init.d/nodedeck-xray; fi; true',
    xrUnitFile: '/etc/init.d/nodedeck-xray',
    cfOn: () => `cat > /etc/init.d/nodedeck-cf <<'NDEOF'\n${OPENRC_CF}NDEOF\nchmod 755 /etc/init.d/nodedeck-cf; rc-update add nodedeck-cf default >/dev/null 2>&1; rc-service nodedeck-cf restart`,
    cfOff: 'if [ -f /etc/init.d/nodedeck-cf ]; then rc-service nodedeck-cf stop >/dev/null 2>&1; rc-update del nodedeck-cf default >/dev/null 2>&1; rm -f /etc/init.d/nodedeck-cf; fi; true',
    remove: `rc-service nodedeck-agent stop >/dev/null 2>&1; rc-service nodedeck-singbox stop >/dev/null 2>&1; rc-service nodedeck-cf stop >/dev/null 2>&1; rc-service nodedeck-xray stop >/dev/null 2>&1
rc-update del nodedeck-agent default >/dev/null 2>&1; rc-update del nodedeck-singbox default >/dev/null 2>&1; rc-update del nodedeck-cf default >/dev/null 2>&1; rc-update del nodedeck-xray default >/dev/null 2>&1
rm -f /etc/init.d/nodedeck-agent /etc/init.d/nodedeck-singbox /etc/init.d/nodedeck-cf /etc/init.d/nodedeck-xray /var/log/nodedeck-*.log`,
  },
};
function svcOf(server) { return SVC[server.initSystem] || SVC.systemd; }

// 调 VPS 上的 agent 命令，读最后一行 JSON
async function agentJSON(ssh, args, timeout = 120000) {
  const r = await ssh.exec(`${AGENT_BIN} ${args}`, { timeout });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) {
    if (/unknown|未知命令|用法/i.test(r.stdout + r.stderr)) throw new Error('VPS 上的 agent 太旧，先点「同步」升级');
    throw new Error((r.stderr || r.stdout || '没有返回结果').trim().slice(0, 300));
  }
}

module.exports = { DIR, SB_BIN, AGENT_BIN, XRAY_BIN, memLimits, xrayUnit, openrcXray, sbUnit, agentUnit, openrcSb, CF_UNIT, OPENRC_CF, openrcAgent, SVC, svcOf, agentJSON };
