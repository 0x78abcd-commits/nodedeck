'use strict';
// 补货提醒，两种方式：
//  1. 内置（轻量）：选一台服务器，它的 agent 定时打开商品页按文字规则判断，变了发 Telegram。不用装东西
//  2. changedetection.io：在一台服务器上用 Docker 一键装（可选带 Chrome，能看 JavaScript 页面），
//     只监听 VPS 本机，NodeDeck 经 SSH 隧道打开它的管理界面，不对外开端口
const net = require('net');
const crypto = require('crypto');
const { SSH, withSSH, shq } = require('./ssh');
const { DIR, AGENT_BIN, agentJSON } = require('./units');

const MODES = { gone: '缺货文字消失', appear: '出现有货文字', regex: '正则匹配' };

function cfg(state) { return state.settings?.stock || {}; }
function stockServer(state) {
  const id = cfg(state).serverId;
  return (state.servers || []).find((s) => s.id === id && s.deployedAt) || null;
}

function newWatch(fields = {}) {
  return { id: 'w' + crypto.randomBytes(4).toString('hex'), name: '', url: '', mode: 'gone', text: '', interval: 120, enabled: true, ...fields };
}

function validWatch(w) {
  if (!/^https?:\/\/[^\s]+$/i.test(String(w.url || '').trim())) throw new Error('商品页地址要以 http:// 或 https:// 开头');
  if (!MODES[w.mode]) throw new Error('判断规则不对');
  if (!String(w.text || '').trim()) throw new Error('要填判断用的文字');
  if (w.mode === 'regex') { try { new RegExp(w.text); } catch (e) { throw new Error('正则写得不对：' + e.message); } }
  return {
    id: w.id || newWatch().id,
    name: String(w.name || '').trim().slice(0, 40) || String(w.url).replace(/^https?:\/\//, '').slice(0, 40),
    url: String(w.url).trim(),
    mode: w.mode,
    text: String(w.text).trim().slice(0, 200),
    interval: Math.min(3600, Math.max(30, Number(w.interval) || 120)),
    enabled: w.enabled !== false,
  };
}

// 写进 agent.json：只有选中的那台有
function agentCfg(state, server) {
  const c = cfg(state);
  if (!c.serverId || server.id !== c.serverId) return null;
  const watches = (c.watches || []).filter((w) => w.enabled !== false);
  return watches.length ? { watches } : null;
}

// 「测试一下」：在选中的服务器上按规则打开一次页面（和真正检查走同一段代码、同一个出口 IP）
async function test(server, w) {
  const v = validWatch(w);
  return withSSH(server, (ssh) => agentJSON(ssh, `stock-check -c ${DIR}/agent.json -url ${shq(v.url)} -mode ${v.mode} -text ${shq(v.text)}`, 60000)
    .catch((e) => { if (/太旧|unknown|未知命令/.test(e.message)) throw new Error('这台服务器的 agent 太旧，先点「同步」升级'); throw e; }));
}

// ---------- changedetection.io ----------
const CD = { name: 'nodedeck-cd', browser: 'nodedeck-cd-browser', net: 'nodedeck-cd', vol: 'nodedeck-cd-data', port: 5000,
  image: 'ghcr.io/dgtlmoon/changedetection.io:latest', imageHub: 'dgtlmoon/changedetection.io:latest', browserImage: 'dgtlmoon/sockpuppetbrowser:latest',
  // 精简模式：个人盯几个商品用不着 10 个并发、详细日志、AI 功能和超长截图；再给容器设内存上限，超了 Docker 会自动重启它
  mem: '320m', browserMem: '800m' };
const LOGS = '--log-opt max-size=2m --log-opt max-file=2';

function cdInstallScript({ browser, port = CD.port }) {
  return `set -e
if ! command -v docker >/dev/null 2>&1; then
  echo "VPS 上没有 Docker，正在用官方脚本安装（约 1–3 分钟）…"
  (curl -fsSL https://get.docker.com || wget -qO- https://get.docker.com) | sh >/dev/null 2>&1 || true
  (systemctl enable --now docker || rc-update add docker default; rc-service docker start) >/dev/null 2>&1 || true
  command -v docker >/dev/null 2>&1 || { echo "✗ Docker 安装失败"; exit 2; }
  echo "Docker 已安装"
fi
docker info >/dev/null 2>&1 || { (systemctl start docker || rc-service docker start) >/dev/null 2>&1; sleep 3; }
docker network inspect ${CD.net} >/dev/null 2>&1 || docker network create ${CD.net} >/dev/null
echo "下载 changedetection.io 镜像…"
IMG=${CD.image}
docker pull -q $IMG >/dev/null 2>&1 || { IMG=${CD.imageHub}; docker pull -q $IMG >/dev/null; }
docker rm -f ${CD.name} ${CD.browser} >/dev/null 2>&1 || true
${browser ? `echo "下载 Chrome 浏览器镜像（约 500MB）…"
docker pull -q ${CD.browserImage} >/dev/null
docker run -d --name ${CD.browser} --restart unless-stopped --network ${CD.net} --cap-add SYS_ADMIN ${LOGS} \\
  --memory ${CD.browserMem} --memory-swap ${CD.browserMem} \\
  -e SCREEN_WIDTH=1280 -e SCREEN_HEIGHT=1024 -e SCREEN_DEPTH=16 -e MAX_CONCURRENT_CHROME_PROCESSES=1 ${CD.browserImage} >/dev/null` : ''}
docker run -d --name ${CD.name} --restart unless-stopped --network ${CD.net} ${LOGS} \\
  --memory ${CD.mem} --memory-swap ${CD.mem} \\
  -e NODEDECK_LEAN=1 -e FETCH_WORKERS=${browser ? 1 : 2} -e LOGGER_LEVEL=WARNING -e DISABLE_VERSION_CHECK=true -e LLM_FEATURES_DISABLED=true \\
  -e MALLOC_ARENA_MAX=2 -e SCREENSHOT_MAX_HEIGHT=8000 \\
  -p 127.0.0.1:${port}:5000 -v ${CD.vol}:/datastore ${browser ? `-e PLAYWRIGHT_DRIVER_URL=ws://${CD.browser}:3000 ` : ''}$IMG >/dev/null
for i in $(seq 1 30); do
  if (curl -fs -o /dev/null http://127.0.0.1:${port}/ || wget -q -O /dev/null http://127.0.0.1:${port}/) 2>/dev/null; then echo "changedetection.io 已启动"; exit 0; fi
  sleep 2
done
echo "✗ 容器起来了但网页没响应："; docker logs --tail 20 ${CD.name} 2>&1; exit 3`;
}

async function cdInstall(server, { browser = false } = {}, log = () => {}) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(cdInstallScript({ browser }), { timeout: 900000, onData: (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => log(l)) });
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim().split('\n').slice(-4).join(' | ') || '安装失败');
    return cdStatusOn(ssh);
  });
}

async function cdStatusOn(ssh) {
  const r = await ssh.exec(`command -v docker >/dev/null 2>&1 || { echo NODOCKER; exit 0; }
A=$(docker inspect -f '{{.State.Status}}' ${CD.name} 2>/dev/null | head -1); echo "\${A:-MISSING}"
B=$(docker inspect -f '{{.State.Status}}' ${CD.browser} 2>/dev/null | head -1); echo "\${B:-MISSING}"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${CD.name} 2>/dev/null | grep -q '^NODEDECK_LEAN=1' && echo LEAN || echo FULL
N=""; [ -n "$A" ] && N="${CD.name}"; [ -n "$B" ] && N="$N ${CD.browser}"
[ -n "$N" ] && docker stats --no-stream --format '{{.MemUsage}}' $N 2>/dev/null | tr '\\n' ';'; echo`);
  const lines = r.stdout.trim().split('\n');
  if (lines[0] === 'NODOCKER') return { installed: false, docker: false };
  return { installed: lines[0] !== 'MISSING', running: lines[0] === 'running', state: lines[0], browser: !!lines[1] && lines[1] !== 'MISSING', browserRunning: lines[1] === 'running', lean: lines[2] === 'LEAN', mem: lines[3] || '', docker: true };
}

const cdStatus = (server) => withSSH(server, cdStatusOn);

async function cdUninstall(server, { keepData = false } = {}) {
  return withSSH(server, async (ssh) => {
    await ssh.exec(`docker rm -f ${CD.name} ${CD.browser} >/dev/null 2>&1; ${keepData ? '' : `docker volume rm ${CD.vol} >/dev/null 2>&1;`} docker network rm ${CD.net} >/dev/null 2>&1; docker image rm ${CD.browserImage} >/dev/null 2>&1; true`);
    return cdStatusOn(ssh);
  });
}

// 经 SSH 隧道打开：本机 127.0.0.1:随机端口 → VPS 的 127.0.0.1:5000。隧道一直开着，直到软件退出或换服务器
const tunnels = new Map(); // serverId → { ssh, srv, port }
async function cdTunnel(server) {
  const cur = tunnels.get(server.id);
  if (cur && cur.alive) return cur.port;
  if (cur) closeTunnel(server.id);
  const ssh = new SSH(server);
  await ssh.connectSmart();
  const t = { ssh, alive: true };
  ssh.conn.on('close', () => { t.alive = false; });
  ssh.conn.on('error', () => { t.alive = false; });
  t.srv = net.createServer((sock) => {
    ssh.conn.forwardOut('127.0.0.1', 0, '127.0.0.1', CD.port, (err, stream) => {
      if (err) { sock.destroy(); return; }
      sock.pipe(stream).pipe(sock);
      sock.on('error', () => stream.destroy());
      stream.on('error', () => sock.destroy());
    });
  });
  await new Promise((resolve, reject) => { t.srv.once('error', reject); t.srv.listen(0, '127.0.0.1', resolve); });
  t.port = t.srv.address().port;
  tunnels.set(server.id, t);
  return t.port;
}
function closeTunnel(id) {
  const t = tunnels.get(id);
  if (!t) return;
  try { t.srv.close(); } catch (_) { /* ignore */ }
  t.ssh.end();
  tunnels.delete(id);
}
function closeAll() { for (const id of [...tunnels.keys()]) closeTunnel(id); }

module.exports = { CD, MODES, cfg, stockServer, newWatch, validWatch, agentCfg, test, cdInstall, cdStatus, cdUninstall, cdTunnel, closeTunnel, closeAll, cdInstallScript, AGENT_BIN };
