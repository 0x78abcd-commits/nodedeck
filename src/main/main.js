'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, net, session, shell, dialog, Menu, nativeTheme } = require('electron');
const core = require('./core');
const tools = require('./tools');
const deploy = require('./deploy');
const netlab = require('./netlab');
const nodetest = require('./nodetest');
const diagnose = require('./diagnose');
const links = require('./links');
const notify = require('./notify');
const proxy = require('./proxy');
const probe = require('./probe');
const stock = require('./stock');
const { setProxyProvider, setHostKeySaver } = require('./ssh');
const { Store } = require('./store');
const { Updater, publish } = require('./updater');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let store;
let updater;

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
const singboxPath = path.join(resourcesDir, 'bin', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
// XHTTP 节点本地测试用（sing-box 不支持 XHTTP）
const xrayPath = path.join(resourcesDir, 'bin', process.platform === 'win32' ? 'xray.exe' : 'xray');

// 服务端 sing-box 内核渠道：本仓库名为 singbox 的 Release（由 singbox.yml 每天自动更新）
function defaultSingboxBase() {
  const owner = publish.owner || 'YOUR_GITHUB_NAME';
  const repo = publish.repo || 'nodedeck';
  return `https://github.com/${owner}/${repo}/releases/download/singbox`;
}

function state() {
  const s = store.state;
  if (!s.settings.singboxBase || s.settings.singboxBase.includes('YOUR_GITHUB_NAME')) s.settings.singboxBase = defaultSingboxBase();
  return s;
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
// 日志脱敏：Telegram 机器人 token、私钥、密码 / token 参数不显示在界面日志里
function redact(text) {
  let t = String(text);
  t = t.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<bot-token>');
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private-key>');
  t = t.replace(/((?:password|passwd|token|secret|private_key|privateKey)["']?\s*[:=]\s*["']?)[^\s"'&,}]{4,}/gi, '$1***');
  for (const sv of state().servers || []) if (sv.password && sv.password.length >= 4) t = t.split(sv.password).join('***');
  return t;
}
function taskLogger(task) { return (line) => send('task-log', { task, line: String(line).startsWith('§') ? String(line) : redact(line), time: Date.now() }); }

// 只允许用浏览器打开 http / https 链接（防止被诱导打开本地文件或其它协议）
function openSafe(url) {
  try { const u = new URL(String(url)); if (u.protocol === 'https:' || u.protocol === 'http:') return shell.openExternal(u.href); } catch (_) { /* ignore */ }
  return false;
}

function getServer(id) {
  const s = state().servers.find((x) => x.id === id);
  if (!s) throw new Error('服务器不存在');
  return s;
}

async function fetchVia(port, url, timeoutMs) {
  const ses = session.fromPartition(`nodedeck-test-${port}`);
  await ses.setProxy({ proxyRules: `http://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
  await ses.closeAllConnections?.();
  return ses.fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
}

function sysFetch(url, opts = {}) { return net.fetch(url, { signal: AbortSignal.timeout(15000), ...opts }); }

// SSH 直连不通时用的本机代理：设置里可选 自动 / 关闭 / 指定地址
async function sshProxies(server) {
  const mode = state().settings.sshProxy || 'auto';
  if (mode === 'off') return [];
  if (mode !== 'auto') { const p = proxy.parseProxyUrl(mode); return p ? [p] : []; }
  let pac = '';
  try { pac = await session.defaultSession.resolveProxy(`https://${server.host}`); } catch (_) { /* ignore */ }
  return proxy.localCandidates(pac);
}

function testEntryFor(userId = 'owner') {
  return (entry) => {
    const s = state();
    const user = s.users.find((u) => u.id === userId) || s.users.find((u) => u.id === 'owner');
    if (core.isXray(entry.protocol)) {
      if (!fs.existsSync(xrayPath)) return Promise.resolve({ ok: false, error: '找不到内置 Xray：' + xrayPath + '（XHTTP 节点要用 Xray 测试）' });
      let outbound;
      try { outbound = core.xrayClientOutbound(s, entry, user); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
      return nodetest.testOutbound({ xrayPath, outbound, fetchVia });
    }
    return nodetest.testOutbound({ singboxPath, outbound: core.clientOutbound(s, entry, user), fetchVia });
  };
}

function appVersionForAgent() { return app.isPackaged ? app.getVersion() : ''; }

async function syncOne(id, log) {
  await beforePush(id);
  const sig = probe.hostSig(state());
  const st = await deploy.syncServer(state(), getServer(id), { log, resourcesDir, appVersion: appVersionForAgent() });
  store.upsert('servers', { id, lastStatus: st, syncedAt: Date.now(), ...(probe.probeOn(state()) && id === state().settings.probe.hostId ? { probeSig: sig } : {}) });
  watchSubCert(id);
  afterPush(id);
  return st;
}

// 推配置前：探针开着就补齐密钥；还没查过地区的查一下（探针网页显示旗帜用，查不到不影响）
async function beforePush(id) {
  if (probe.ensureKeys(state())) store.save();
  const s = getServer(id);
  if (s && !s.geo?.cc && probe.probeOn(state())) {
    try {
      const j = await tools.ipInfo(sysFetch, String(s.host).replace(/^\[|\]$/g, ''));
      if (j.countryCode) store.upsert('servers', { id, geo: { cc: j.countryCode, country: j.country || '' } });
    } catch (_) { /* ignore */ }
  }
}

// 推完配置后：主控上的机器列表过期了（加了 / 删了 / 改名服务器），过几秒在后台同步一下主控
let probeHostTimer = null;
function afterPush(id) {
  const st = state();
  if (!probe.probeOn(st)) return;
  const hostId = st.settings.probe.hostId;
  if (id === hostId || probe.hostOf(st)?.probeSig === probe.hostSig(st)) return;
  clearTimeout(probeHostTimer);
  probeHostTimer = setTimeout(async () => {
    try { await syncOne(hostId, () => {}); } catch (e) { send('toast', { text: '探针主控同步失败：' + e.message, level: 'err' }); }
  }, 3000);
}

// 订阅 HTTPS 证书是 agent 重启后在后台申请的（十几秒到一两分钟）：同步完过一会儿再读一次状态，
// 拿到证书后订阅地址自动变成 https
const subCertWatch = new Map();
function watchSubCert(id, tries = 0) {
  clearTimeout(subCertWatch.get(id));
  const s = state().servers.find((x) => x.id === id);
  if (!s || !s.deployedAt || !core.subTlsWanted(state()) || core.subCertOk(state(), s) || tries >= 4) return;
  subCertWatch.set(id, setTimeout(async () => {
    try {
      const st = await deploy.serverStatus(getServer(id));
      store.upsert('servers', { id, lastStatus: st });
      if (core.subCertOk(state(), getServer(id))) { send('toast', { text: `${getServer(id).name} 的订阅证书申请好了，订阅地址变成 https://（旧的 http 地址继续能用）`, level: 'ok' }); return; }
    } catch (_) { /* ignore */ }
    watchSubCert(id, tries + 1);
  }, [45000, 120000, 300000, 900000][tries]));
}

// 部署后从本机测 TCP 协议端口，不通的自动换端口（每个最多 3 次）；全部不通时不改动
async function autoFixPorts(id, log) {
  const tcpKeys = () => Object.entries(core.PROTOCOLS).filter(([k, m]) => core.netsOf(m.net).includes('tcp') && getServer(id).protocols?.[k]?.enabled).map(([k]) => k);
  const keys = tcpKeys();
  if (!keys.length) return [];
  const srv = getServer(id);
  log('从本机测试协议端口 …');
  const first = await Promise.all(keys.map((k) => tools.tcpPing(srv.host, srv.protocols[k].port, 5000)));
  if (first.every((r) => r.ok)) { log('端口自测通过 ✔'); return []; }
  if (first.every((r) => !r.ok)) {
    log('⚠ 所有 TCP 协议端口从本机都连不通：多半是云厂商安全组没放行，或 IP 被墙。已保留原端口，可以点「体检」查看原因（UDP 协议无法这样测）');
    return [];
  }
  const changes = [];
  for (let i = 0; i < keys.length; i++) {
    if (first[i].ok) continue;
    const k = keys[i];
    const label = core.PROTOCOLS[k].label;
    if (getServer(id).protocols[k].fixedPort || (k === 'vmess' && core.cfTunnelOf(getServer(id)))) { log(`⚠ ${label} 端口 ${getServer(id).protocols[k].port} 不通，但它是固定端口，没有自动更换`); continue; }
    const original = getServer(id).protocols[k].port;
    let fixed = false;
    const tried = [original];
    for (let attempt = 1; attempt <= 3 && !fixed; attempt++) {
      const cur = getServer(id);
      const port = core.pickFreePort(state(), cur, k, tried);
      tried.push(port);
      store.upsert('servers', { id, protocols: { ...cur.protocols, [k]: { ...cur.protocols[k], port } } });
      log(`${label} 端口 ${original} 不通，换成 ${port} 再试（第 ${attempt} 次）…`);
      await syncOne(id, () => {});
      const r = await tools.tcpPing(getServer(id).host, port, 5000);
      if (r.ok) { fixed = true; changes.push(`${label}：${original} → ${port}`); log(`✔ ${label} 已换到端口 ${port}`); }
    }
    if (!fixed) {
      const cur = getServer(id);
      store.upsert('servers', { id, protocols: { ...cur.protocols, [k]: { ...cur.protocols[k], port: original } } });
      await syncOne(id, () => {});
      log(`⚠ ${label} 换了 3 个端口都不通，已改回 ${original}`);
    }
  }
  return changes;
}

// 从各服务器拉取本周期流量、在用时间、首次使用时间
const realityAdopted = [];
let refreshing = null;
async function refreshUsage() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const s = state();
    const errors = [];
    const now = Date.now();
    for (const srv of s.servers.filter((x) => x.deployedAt)) {
      try {
        const st = await deploy.fetchStats(srv, s);
        srv.lastStats = { today: st.today, yesterday: st.yesterday, at: now };
        if (st.reality) {
          srv.realityState = st.reality;
          const rp = srv.protocols?.vlessReality;
          if (core.realityOn(srv) && st.reality.override && st.reality.from === rp.sni) {
            Object.assign(rp, { sni: st.reality.override, sniSource: 'patrol', sniPickedAt: (st.reality.changedAt || 0) * 1000, sniCheck: { domain: st.reality.override, ok: true, at: (st.reality.changedAt || 0) * 1000, where: 'vps', via: 'patrol' } });
            realityAdopted.push(srv.id);
          }
        }
        for (const u of s.users) {
          if (!core.userHasServer(u, srv.id)) continue;
          const t = st.traffic?.[u.id] || { up: 0, down: 0 };
          u.usage = { ...(u.usage || {}), [srv.id]: { up: t.up || 0, down: t.down || 0 } };
          u.usageAt = now;
          const la = (st.lastActive?.[u.id] || 0) * 1000;
          if (la > (u.lastActive || 0)) u.lastActive = la;
          const fu = (st.firstUsed?.[u.id] || 0) * 1000;
          if (fu && u.expireAfterDays > 0 && (!u.firstUsedAt || fu < u.firstUsedAt)) u.firstUsedAt = fu;
        }
      } catch (e) { errors.push(`${srv.name}: ${e.message}`); }
    }
    store.save();
    // VPS 自动换过 Reality 目标：同步这台和共享用户的服务器，让所有订阅都更新
    if (realityAdopted.length) {
      const ids = new Set(realityAdopted.splice(0));
      for (const id of ids) for (const u of state().users) if (core.userHasServer(u, id)) for (const x of state().servers) if (x.deployedAt && core.userHasServer(u, x.id)) ids.add(x.id);
      for (const id of ids) { try { await syncOne(id, () => {}); } catch (e) { errors.push(`${getServer(id)?.name}: 同步新 Reality 目标失败：${e.message}`); } }
      send('toast', { text: 'VPS 自动更换了失效的 Reality 目标，已同步到相关服务器的订阅', level: 'warn' });
    }
    return { errors, users: state().users };
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// ---------- 被墙巡检（软件开着时每 30 分钟一次）----------
// 本机连不通、海外能通，连续两次判定为被墙后：notify 只提醒；auto 自动一键换新（6 小时内最多一次），换完复测
const blockState = {};
function mainTcpPort(srv) {
  for (const k of ['vlessReality', 'trojan', 'anytls', 'vmess', 'vlessXhttpReality', 'vlessXhttpTls', 'shadowsocks']) if (srv.protocols?.[k]?.enabled) return { key: k, port: Number(srv.protocols[k].port) };
  return null;
}
async function notifyAll(srv, text) {
  send('toast', { text: `${srv.name}：${text}`, level: 'warn' });
  if (notify.anyOn(state().settings)) { try { await deploy.adminNotify(srv, text); } catch (_) { /* VPS 连不上就算了 */ } }
}
async function blockWatchTick() {
  const mode = state().settings.blockWatch || 'off'; // 默认关
  if (mode === 'off') return;
  const list = state().servers.filter((x) => x.deployedAt && x.role !== 'relay' && mainTcpPort(x));
  if (!list.length) return;
  // 对照组：本机连国内大站都不通，说明是自己网络的问题，不判断
  const ctl = await tools.tcpPing('www.baidu.com', 443, 5000);
  if (!ctl.ok) return;
  const results = [];
  for (const srv of list) {
    const mp = mainTcpPort(srv);
    const local = await tools.tcpPing(srv.host, mp.port, 5000);
    if (local.ok) { blockState[srv.id] = 0; continue; }
    results.push({ srv, mp });
  }
  if (results.length && results.length === list.length && list.length > 1) return; // 全部不通更像本机网络问题
  for (const { srv, mp } of results) {
    let r;
    try { r = await diagnose.blockCheck(sysFetch, srv.host, mp.port); } catch (_) { continue; }
    if (!r.verdict.blocked) { blockState[srv.id] = 0; continue; }
    blockState[srv.id] = (blockState[srv.id] || 0) + 1;
    if (blockState[srv.id] < 2) continue;
    blockState[srv.id] = 0;
    const label = core.PROTOCOLS[mp.key].label;
    if (mode !== 'auto' || (srv.autoRotatedAt && Date.now() - srv.autoRotatedAt < 6 * 3600e3)) {
      await notifyAll(srv, `🚫 ${label} 端口 ${mp.port} 疑似被墙（国内连不通、海外能通）。可以在 NodeDeck 里点「一键换新」`);
      continue;
    }
    const rot = core.rotateServer(state(), getServer(srv.id));
    store.upsert('servers', { ...rot.server, autoRotatedAt: Date.now() });
    try { await syncOne(srv.id, () => {}); } catch (e) { await notifyAll(srv, `🚫 疑似被墙，自动换新后同步失败：${e.message}`); continue; }
    await new Promise((res) => setTimeout(res, 30000));
    const np = mainTcpPort(getServer(srv.id));
    const again = await tools.tcpPing(srv.host, np.port, 5000);
    await notifyAll(srv, again.ok
      ? `🔁 ${label} 端口 ${mp.port} 疑似被墙，已自动一键换新（${rot.changes.join('；')}），新端口本机可连通。请让用户刷新订阅`
      : `🚫 ${label} 疑似被墙，已自动换端口和密钥但新端口仍连不通：多半是 IP 被墙，建议换 IP 或开 Cloudflare 隧道`);
  }
}

function parseLandingLines(lines) {
  const out = [];
  for (const raw of lines.map((x) => x.trim()).filter(Boolean).slice(0, 500)) {
    try {
      if (/^[a-z0-9+]+:\/\//i.test(raw) && !/^socks5?h?:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
        const r = links.parseShareLink(raw, 'exit');
        out.push({ ok: true, name: r.name, landing: { type: 'link', link: raw, host: r.outbound.server, port: r.outbound.server_port, proto: r.outbound.type } });
      } else {
        const isHttp = /^https?:\/\//i.test(raw);
        const p = tools.parseSocks(raw.replace(/^https?:\/\//i, ''));
        out.push({ ok: true, name: p.name, landing: { type: isHttp ? 'http' : 'socks', host: p.host, port: p.port, username: p.user, password: p.pass } });
      }
    } catch (e) { out.push({ ok: false, input: raw.slice(0, 80), error: e.message }); }
  }
  return out;
}

function readChangelog() {
  try { return fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8'); } catch (_) { return ''; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    // 和界面主题一致，避免打开时闪一下另一种颜色
    backgroundColor: (() => { const t = state().settings.theme || 'system'; return t === 'dark' || (t === 'system' && nativeTheme.shouldUseDarkColors) ? '#0f1316' : '#eceff1'; })(),
    title: `NodeDeck ${app.getVersion()}`,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); openSafe(url); } });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) win.webContents.toggleDevTools();
  });
}

// ---------- IPC ----------
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
  });
}

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, portable: !!process.env.PORTABLE_EXECUTABLE_DIR, repo: publish.owner ? `${publish.owner}/${publish.repo}` : '', singbox: fs.existsSync(singboxPath), xray: fs.existsSync(xrayPath), dataDir: app.getPath('userData'), realityTargets: core.REALITY_FALLBACKS }));
  handle('state:get', () => state());
  handle('col:upsert', (col, item) => store.upsert(col, item));
  handle('col:remove', (col, id) => store.remove(col, id));
  handle('settings:set', (patch) => { store.setSettings(patch); return state().settings; });
  // 补货提醒
  const stockInfo = () => {
    const st = state();
    const c = stock.cfg(st);
    const srv = stock.stockServer(st);
    return { serverId: c.serverId || '', serverName: srv?.name || '', watches: c.watches || [], status: srv?.lastStatus?.stock || {}, statusAt: srv?.lastStatus?.at || 0,
      agentOld: !!(srv && srv.lastStatus && !('stock' in srv.lastStatus)), cd: st.settings.cd || {}, notifyUrls: notify.appriseUrls(st.settings), notifyOn: notify.anyOn(st.settings), channels: notify.channels(st.settings), modes: stock.MODES };
  };
  handle('stock:info', stockInfo);
  handle('stock:newWatch', () => stock.newWatch());
  handle('stock:save', async ({ serverId, watches }) => {
    const cur = stock.cfg(state());
    const list = (watches || []).map(stock.validWatch);
    if (list.length && !serverId) throw new Error('先选一台已部署的服务器来做检查');
    store.setSettings({ stock: { serverId: serverId || '', watches: list } });
    const ids = [...new Set([cur.serverId, serverId].filter((id) => id && getServer(id)?.deployedAt))];
    const results = [];
    for (const id of ids) {
      try { await syncOne(id, () => {}); results.push({ id, name: getServer(id).name, ok: true }); } catch (e) { results.push({ id, name: getServer(id).name, ok: false, error: e.message }); }
    }
    return { results, info: stockInfo() };
  });
  handle('stock:test', (serverId, w) => stock.test(getServer(serverId), w));
  handle('stock:refresh', async () => {
    const srv = stock.stockServer(state());
    if (!srv) return stockInfo();
    const st = await deploy.serverStatus(srv);
    store.upsert('servers', { id: srv.id, lastStatus: st });
    return stockInfo();
  });
  handle('cd:install', async (serverId, opts = {}) => {
    const log = taskLogger('cd:' + serverId);
    const st = await stock.cdInstall(getServer(serverId), opts, log);
    store.setSettings({ cd: { serverId, browser: !!opts.browser, installedAt: Date.now() } });
    return st;
  });
  handle('cd:status', (serverId) => stock.cdStatus(getServer(serverId)));
  handle('cd:open', async (serverId) => { const port = await stock.cdTunnel(getServer(serverId)); openSafe(`http://127.0.0.1:${port}/`); return port; });
  handle('cd:uninstall', async (serverId, opts = {}) => {
    stock.closeTunnel(serverId);
    const st = await stock.cdUninstall(getServer(serverId), opts);
    store.setSettings({ cd: {} });
    return st;
  });

  // 探针网页
  handle('probe:info', () => probe.info(state()));
  handle('probe:save', async (p) => {
    const cur = state().settings.probe || {};
    const next = { ...cur, ...p };
    if (p.newLink) { next.token = ''; delete next.newLink; }
    store.setSettings({ probe: next });
    probe.ensureKeys(state());
    store.save();
    // 开 / 关、换主控要同步所有机器（密钥、接口开关）；只改标题、告警、隐藏、换链接只需同步主控
    const all = cur.enabled !== next.enabled || cur.hostId !== next.hostId;
    const ids = state().servers.filter((x) => x.deployedAt && (all || x.id === next.hostId || x.id === cur.hostId)).map((x) => x.id);
    const results = [];
    for (const id of ids) {
      try { await syncOne(id, () => {}); results.push({ id, name: getServer(id).name, ok: true }); } catch (e) { results.push({ id, name: getServer(id).name, ok: false, error: e.message }); }
    }
    return { results, info: probe.info(state()) };
  });
  handle('new:server', (fields) => core.newServer(fields));
  handle('new:user', (fields) => core.newUser(fields));
  handle('new:reality', () => core.realityKeypair());
  handle('open:external', (url) => openSafe(url));

  // 节点
  handle('nodes:list', () => {
    const s = state();
    const owner = s.users.find((u) => u.id === 'owner');
    return s.servers.map((srv) => ({
      server: { id: srv.id, name: srv.name, host: srv.host, deployedAt: srv.deployedAt },
      entries: core.nodeEntries(s, srv).map((e) => ({ ...e, link: core.shareLink(s, e, owner) })),
    }));
  });
  handle('node:test', async (entry, userId = 'owner') => {
    if (!fs.existsSync(singboxPath)) throw new Error('找不到内置 sing-box：' + singboxPath);
    const s = state();
    const user = s.users.find((u) => u.id === userId) || s.users.find((u) => u.id === 'owner');
    return testEntryFor(user.id)(entry);
  });
  handle('landing:test', async (id) => {
    if (!fs.existsSync(singboxPath)) throw new Error('找不到内置 sing-box：' + singboxPath);
    const l = state().landings.find((x) => x.id === id);
    if (!l) throw new Error('落地不存在');
    return nodetest.testOutbound({ singboxPath, outbound: core.landingOutbound(l, 'proxy'), fetchVia });
  });
  handle('qr', (text) => tools.qr(text));
  // 批量识别落地：每行一个，支持 ip:端口:用户:密码、socks5://、各种节点分享链接
  handle('landing:parse', (text) => parseLandingLines(String(text).split(/\r?\n/)));
  // 从机场订阅导入落地
  handle('landing:fetchSub', async (url) => {
    const r = await sysFetch(url.trim(), { headers: { 'User-Agent': 'v2rayN/7.0' } });
    if (!r.ok) throw new Error('订阅返回 HTTP ' + r.status);
    const list = links.splitSubscription(await r.text());
    if (!list.length) throw new Error('订阅里没有识别到节点（可能是 Clash 格式，请换成通用订阅地址）');
    return parseLandingLines(list);
  });

  // 服务器
  handle('server:testSsh', (srv) => deploy.testSSH(srv));
  handle('server:deploy', async (id) => {
    await beforePush(id);
    const srv = getServer(id);
    const log = taskLogger('deploy:' + id);
    const st = await deploy.deployServer(state(), srv, { resourcesDir, log });
    store.upsert('servers', { id, deployedAt: Date.now(), lastStatus: st });
    afterPush(id);
    let portChanges = [];
    log('§ports');
    try { portChanges = await autoFixPorts(id, log); } catch (e) { log('端口自测出错：' + e.message); }
    log('§done');
    return { ...st, portChanges };
  });
  handle('server:sync', async (id) => {
    return syncOne(id, taskLogger('sync:' + id));
  });
  handle('server:syncAll', async () => {
    const results = [];
    for (const srv of state().servers.filter((x) => x.deployedAt)) {
      try {
        await syncOne(srv.id, () => {});
        results.push({ id: srv.id, name: srv.name, ok: true });
      } catch (e) { results.push({ id: srv.id, name: srv.name, ok: false, error: e.message }); }
    }
    return results;
  });
  handle('server:status', async (id) => {
    const st = await deploy.serverStatus(getServer(id));
    store.upsert('servers', { id, lastStatus: st });
    return st;
  });
  handle('server:updateSingbox', async (id) => {
    const r = await deploy.updateSingbox(getServer(id));
    store.upsert('servers', { id, lastStatus: r.status });
    return r.message;
  });
  handle('server:diagnose', async (id) => {
    const log = taskLogger('diag:' + id);
    return diagnose.diagnoseServer(state(), getServer(id), {
      deploy, fetchFn: sysFetch, log: (step) => log(JSON.stringify(step)),
      testEntry: fs.existsSync(singboxPath) ? testEntryFor('owner') : null,
    });
  });
  handle('server:rotate', async (id) => {
    const r = core.rotateServer(state(), getServer(id));
    store.upsert('servers', r.server);
    let synced = false;
    let error = '';
    if (getServer(id).deployedAt) {
      try { await syncOne(id, taskLogger('sync:' + id)); synced = true; } catch (e) { error = e.message; }
    }
    return { changes: r.changes, synced, error };
  });
  handle('server:repickReality', async (id) => {
    const log = taskLogger('sync:' + id);
    const pick = await deploy.pickReality(getServer(id), log);
    if (!pick) throw new Error('没有找到合适的 Reality 目标');
    const cur = getServer(id);
    store.upsert('servers', { id, protocols: { ...cur.protocols, vlessReality: { ...cur.protocols.vlessReality, sni: pick.domain, sniAuto: true, sniSource: pick.source, sniPickedAt: Date.now(), sniCheck: pick.check } } });
    await syncOne(id, log);
    return pick;
  });
  handle('server:realityCheck', (id) => deploy.realityCheck(getServer(id)));
  handle('servers:batch', async (ids, action, arg) => {
    const ok = [], fail = [];
    for (const id of ids) {
      const srv = getServer(id);
      if (!srv) continue;
      try {
        if (action === 'rotate') store.upsert('servers', core.rotateServer(state(), srv).server);
        else if (action === 'routing') store.upsert('servers', { id, routing: { ...(srv.routing || {}), ...arg } });
        else if (action === 'realitySni') {
          if (!core.realityOn(srv)) { fail.push(`${srv.name}：没开 Reality`); continue; }
          if (arg === '__auto__') {
            const pick = srv.deployedAt ? await deploy.pickReality(srv) : null;
            if (!pick) throw new Error('没找到合适的目标');
            store.upsert('servers', { id, protocols: { ...srv.protocols, vlessReality: { ...srv.protocols.vlessReality, sni: pick.domain, sniAuto: true, sniSource: pick.source, sniPickedAt: Date.now(), sniCheck: pick.check } } });
          } else {
            // 固定目标：已部署的先在 VPS 上检测，不通过就不改
            const d = String(arg).trim();
            let check;
            if (srv.deployedAt) {
              check = await deploy.remoteTlsCheck(srv, d);
              if (!check.ok) throw new Error(`${d} 在 VPS 上检测不通过：${(check.checks || []).filter((x) => !x.ok).map((x) => x.name).join('、') || check.error}，没有修改`);
            }
            store.upsert('servers', { id, protocols: { ...srv.protocols, vlessReality: { ...srv.protocols.vlessReality, sni: d, sniAuto: false, sniPickedAt: undefined, sniSource: undefined, sniCheck: check } } });
          }
        } else if (action !== 'sync') throw new Error('未知操作');
        if (getServer(id).deployedAt) await syncOne(id, taskLogger('sync:' + id));
        ok.push(srv.name);
      } catch (e) { fail.push(`${srv.name}：${e.message}`); }
    }
    return { ok, fail };
  });
  handle('users:tempSub', async (userId, hours) => {
    const u = state().users.find((x) => x.id === userId);
    if (!u) throw new Error('用户不存在');
    const now = Date.now();
    const temp = (u.tempSubs || []).filter((t) => t.validUntil > now);
    const t = { token: core.randId(24), validUntil: now + Math.max(1, Number(hours) || 24) * 3600e3, createdAt: now };
    t.url = core.subscriptionUrl(state(), { ...u, token: t.token });
    temp.push(t);
    store.upsert('users', { id: userId, tempSubs: temp });
    const errors = [];
    for (const x of state().servers) if (x.deployedAt && core.userHasServer(u, x.id)) { try { await syncOne(x.id, () => {}); } catch (e) { errors.push(`${x.name}：${e.message}`); } }
    return { url: t.url, validUntil: t.validUntil, errors };
  });
  handle('users:tempSubRemove', async (userId, token) => {
    const u = state().users.find((x) => x.id === userId);
    store.upsert('users', { id: userId, tempSubs: (u.tempSubs || []).filter((t) => t.token !== token) });
    for (const x of state().servers) if (x.deployedAt && core.userHasServer(u, x.id)) { try { await syncOne(x.id, () => {}); } catch (_) { /* ignore */ } }
    return true;
  });
  // ---------- 网络优化 ----------
  const netSave = (id, patch) => { const cur = getServer(id); store.upsert('servers', { id, netLab: { ...(cur.netLab || {}), ...patch } }); return getServer(id).netLab; };
  const netLog = (id) => taskLogger('net:' + id);
  // 测速口令：第一次测速时生成并同步到 VPS（agent 用它校验测速请求）
  async function ensureSpeedToken(id) {
    if (getServer(id).speedToken) return;
    store.upsert('servers', { id, speedToken: core.randId(32) });
    netLog(id)('第一次测速：先把测速口令同步到 VPS …');
    await syncOne(id, netLog(id));
  }
  handle('net:info', async (id) => netSave(id, { info: { ...(await deploy.netInfo(getServer(id))), at: Date.now() } }));
  handle('net:tune', async (id, keys) => {
    const r = await deploy.netTune(getServer(id), keys || []);
    store.upsert('servers', { id, netTunedAt: Date.now() });
    netSave(id, { info: { ...r.info, at: Date.now() } });
    return r;
  });
  handle('net:restore', async (id) => {
    const r = await deploy.netRestore(getServer(id));
    netSave(id, { info: { ...r.info, at: Date.now() } });
    return r;
  });
  handle('net:trace', async (id) => netSave(id, { trace: { list: await deploy.netTrace(getServer(id)), at: Date.now() } }));
  handle('net:traceForward', async (id) => netSave(id, { fwd: { ...(await netlab.forwardTrace(getServer(id).host)), at: Date.now() } }));
  handle('net:ping', async (id) => netSave(id, { ping: { list: await deploy.netPing(getServer(id)), at: Date.now() } }));
  handle('net:mtu', async (id) => netSave(id, { mtu: { ...(await deploy.netMtu(getServer(id))), at: Date.now() } }));
  handle('net:speed', async (id) => {
    await ensureSpeedToken(id);
    const r = await netlab.speedTest(state(), getServer(id));
    if (r.down?.error && r.up?.error) throw new Error(`测速失败：${r.down.error}。VPS 的订阅端口可能没放行，或者 agent 还是旧版（先点「同步」）`);
    return netSave(id, { speed: r });
  });
  handle('net:udp', async (id) => {
    await ensureSpeedToken(id);
    return netSave(id, { udp: await netlab.udpTest(state(), getServer(id)) });
  });
  handle('net:peak', async (id) => {
    const m = await deploy.fetchMetrics(getServer(id), '7d');
    return { report: netlab.peakReport(m.series, state().settings.timezone || 'Asia/Shanghai'), hours: (m.series || []).length, now: m.now };
  });
  handle('net:advice', (id) => { const s = getServer(id); return netlab.quicAdvice(s, s.netLab?.udp, s.netLab?.speed); });
  handle('net:fixQuic', async (id, action) => {
    const s = getServer(id);
    const hy = { ...s.protocols.hysteria2 };
    if (action === 'antiqos') { if (!hy.obfs) hy.obfs = core.randId(16); if (!hy.hopPorts) hy.hopPorts = '20000-30000'; }
    else if (action === 'hycap0') { hy.upMbps = 0; hy.downMbps = 0; }
    else throw new Error('未知操作');
    store.upsert('servers', { id, protocols: { ...s.protocols, hysteria2: hy } });
    const errs = core.checkPortConflicts(state(), getServer(id));
    if (errs.length) { store.upsert('servers', { id, protocols: s.protocols }); throw new Error(errs.join('；')); }
    await syncOne(id, netLog(id));
    return true;
  });
  // BBR 和 CUBIC 对比：交替切换，每轮从 VPS 下载 8 秒，比较速度、首字节时间和重传率；最后恢复原来的设置
  handle('net:compare', async (id, rounds = 3) => {
    await ensureSpeedToken(id);
    const srv = getServer(id);
    const base = netlab.speedBase(state(), srv);
    const log = netLog(id);
    const res = await deploy.withCC(srv, async ({ setCC, tcp, info }) => {
      const ni = await info();
      if (!ni.bbrSupport) throw new Error('这台的内核不支持 BBR，没法对比：' + (ni.bbrNote || ''));
      const orig = ni.cc;
      const out = { bbr: [], cubic: [], orig };
      try {
        const order = [];
        for (let i = 0; i < rounds; i++) order.push(i % 2 ? 'bbr' : 'cubic', i % 2 ? 'cubic' : 'bbr');
        for (const [n, cc] of order.entries()) {
          const r = await setCC(cc);
          if (r.error) throw new Error(`切换到 ${cc} 失败：${r.error}（容器 VPS 通常不能改）`);
          const t0 = await tcp();
          const d = await netlab.downloadTest(base, 8);
          const t1 = await tcp();
          const out1 = t1.outSegs - t0.outSegs; const re1 = t1.retransSegs - t0.retransSegs;
          const row = { mbps: d.mbps || 0, ttfb: d.ttfbMs || 0, retr: out1 > 0 ? (100 * re1) / out1 : 0, error: d.error };
          out[cc].push(row);
          log(`第 ${n + 1}/${order.length} 轮 ${cc.toUpperCase()}：${d.error ? '失败 ' + d.error : `${row.mbps.toFixed(1)} Mbps，重传 ${row.retr.toFixed(2)}%`}`);
        }
      } finally {
        await setCC(orig).catch(() => {});
      }
      return out;
    });
    const avg = (v, k) => { const x = v.filter((r) => !r.error); return x.length ? x.reduce((a, r) => a + r[k], 0) / x.length : 0; };
    const sum = { bbr: { mbps: avg(res.bbr, 'mbps'), retr: avg(res.bbr, 'retr'), ttfb: avg(res.bbr, 'ttfb') }, cubic: { mbps: avg(res.cubic, 'mbps'), retr: avg(res.cubic, 'retr'), ttfb: avg(res.cubic, 'ttfb') } };
    const better = sum.bbr.mbps > sum.cubic.mbps * 1.15 ? 'bbr' : sum.cubic.mbps > sum.bbr.mbps * 1.15 ? 'cubic' : '';
    return netSave(id, { compare: { ...res, sum, better, at: Date.now() } });
  });
  // ---------- 社区测试脚本 ----------
  handle('bench:start', (id, kind, opts) => deploy.benchStart(getServer(id), kind, opts));
  handle('bench:stop', (id, kind) => deploy.benchStop(getServer(id), kind));
  handle('bench:poll', async (id, kind, offset) => {
    const r = await deploy.benchPoll(getServer(id), kind, offset);
    if (r.url) {
      const s = getServer(id);
      const list = s.benchReports || [];
      if (!list.some((x) => x.url === r.url)) store.upsert('servers', { id, benchReports: [{ kind, url: r.url, at: Date.now() }, ...list].slice(0, 30) });
    }
    return r;
  });
  handle('server:metrics', (id, range) => deploy.fetchMetrics(getServer(id), range));
  handle('tools:realityScan', (serverId) => deploy.scanReality(getServer(serverId)));
  handle('server:logs', (id) => deploy.serverLogs(getServer(id)));
  handle('server:uninstall', async (id) => {
    await deploy.uninstall(getServer(id));
    store.upsert('servers', { id, deployedAt: null, lastStatus: null });
    return true;
  });

  // 用户
  handle('user:sub', async (id) => {
    const s = state();
    const u = s.users.find((x) => x.id === id);
    if (!u) throw new Error('用户不存在');
    const url = core.subscriptionUrl(s, u);
    const sub = core.buildSubscription(s, u);
    return {
      url, clashUrl: url ? url + '?format=clash' : '', singboxUrl: url ? url + '?format=singbox' : '', pageUrl: url ? url + '?format=html' : '',
      backups: core.subscriptionUrls(s, u).filter((x) => x.url !== url),
      links: sub.links, qr: url ? await tools.qr(url) : null, status: core.userStatus(u), used: core.userUsedBytes(u), expireAt: core.userExpireAt(u),
      https: (() => {
        if (!core.subTlsWanted(s)) return null;
        const home = s.servers.find((x) => x.id === core.homeServerId(s, u));
        const c = home?.lastStatus?.subCert;
        return { ok: core.subCertOk(s, home), error: c?.error || '', notAfter: c?.notAfter || 0, server: home?.name || '' };
      })(),
    };
  });
  handle('users:refreshUsage', () => refreshUsage());
  handle('users:batch', async (ids, op) => {
    const s = state();
    const set = new Set(ids);
    let n = 0;
    for (const u of s.users) {
      if (!set.has(u.id)) continue;
      n++;
      if (op.type === 'addServers') {
        if (u.serverIds !== '*') u.serverIds = [...new Set([...(u.serverIds || []), ...op.serverIds])];
      } else if (op.type === 'removeServers') {
        if (u.serverIds === '*') u.serverIds = s.servers.map((x) => x.id);
        u.serverIds = u.serverIds.filter((x) => !op.serverIds.includes(x));
      } else if (op.type === 'extend') {
        const base = Math.max(Date.now(), u.expireAt || 0);
        u.expireAt = base + op.days * 86400000;
        u.expireAfterDays = 0;
      } else if (op.type === 'limit') {
        u.limitGB = Number(op.limitGB) || 0;
      } else if (op.type === 'enable') {
        u.enabled = !!op.enabled;
      } else if (op.type === 'delete') {
        if (u.id === 'owner') { n--; continue; }
        u._delete = true;
      }
    }
    s.users = s.users.filter((u) => !u._delete);
    store.save();
    return n;
  });
  handle('telegram:test', async (serverId) => deploy.notifyTest(getServer(serverId)));
  handle('users:resetUsage', async (id) => {
    const s = state();
    const u = s.users.find((x) => x.id === id);
    const errors = [];
    for (const srv of s.servers.filter((x) => x.deployedAt && core.userHasServer(u, x.id))) {
      try { await deploy.resetTraffic(srv, id); } catch (e) { errors.push(`${srv.name}: ${e.message}`); }
    }
    u.usage = {};
    store.save();
    return { errors };
  });

  // 工具箱
  handle('tools:ip', (ip) => tools.ipInfo(sysFetch, ip));
  handle('tools:ports', (host, ports) => tools.portCheck(host, ports));
  handle('tools:dns', (name, type, server) => tools.dnsLookup(name, type, server));
  handle('tools:trace', (host) => tools.traceroute(host, taskLogger('trace')));
  // 清理其他面板 / 代理程序
  handle('server:scanOthers', (id) => deploy.scanOthers(getServer(id)));
  handle('server:cleanOthers', (id, items, opts) => deploy.cleanOthers(getServer(id), items || [], taskLogger('clean:' + id), opts || {}));
  // 恢复前先算好端口怎么让：恢复的程序 / compose 容器要用的端口如果被 NodeDeck 的节点占着，把节点挪到空闲端口；
  // 普通容器直接换一个空闲的主机端口
  async function restorePlan(id, bid) {
    const srv = getServer(id);
    const info = await deploy.backupInfo(srv, bid);
    const st = state();
    const ours = [];
    for (const [k, p] of Object.entries(srv.protocols || {})) if (p?.enabled && core.PROTOCOLS[k]) for (const n of core.netsOf(core.PROTOCOLS[k].net)) ours.push({ key: k, port: Number(p.port), proto: n, fixed: !!p.fixedPort });
    const otherBusy = info.busy.filter((b) => !/^nodedeck/.test(b.pname));
    const k2 = (port, proto) => `${port}/${proto}`;
    const need = new Map(); // 恢复后固定要用的端口 → 谁要用
    for (const a of info.meta.apps || []) for (const p of a.ports || []) need.set(p, a.name);
    const plain = []; // 可以换主机端口的普通容器
    for (const ins of info.containers) {
      const name = String(ins.Name || '').replace(/^\//, '');
      const compose = !!ins.Config?.Labels?.['com.docker.compose.project.working_dir'];
      for (const [cp, binds] of Object.entries(ins.HostConfig?.PortBindings || {})) {
        const proto = cp.split('/')[1] || 'tcp';
        for (const b of binds || []) {
          if (!b.HostPort) continue;
          if (compose) need.set(k2(b.HostPort, proto), `容器 ${name}`); else plain.push({ name, port: Number(b.HostPort), proto });
        }
      }
    }
    const warnings = [];
    const moves = [];
    const taken = new Set([...info.busy.map((b) => k2(b.port, b.proto)), ...need.keys(), ...plain.map((x) => k2(x.port, x.proto))]);
    for (const o of ours) {
      const who = need.get(k2(o.port, o.proto));
      if (!who || moves.some((m) => m.key === o.key)) continue;
      const label = core.PROTOCOLS[o.key].label;
      if (o.fixed) { warnings.push(`${who} 要用 ${o.port}/${o.proto}，但 NodeDeck 的 ${label} 是固定端口，没有挪，${who} 可能起不来`); continue; }
      const to = core.pickFreePort(st, srv, o.key, [...taken].map((x) => Number(x.split('/')[0])));
      for (const n of core.netsOf(core.PROTOCOLS[o.key].net)) taken.add(k2(to, n));
      moves.push({ key: o.key, label, from: o.port, to, who });
    }
    const ourNow = new Set(ours.filter((o) => !moves.some((m) => m.key === o.key)).map((o) => k2(o.port, o.proto)));
    for (const m of moves) for (const n of core.netsOf(core.PROTOCOLS[m.key].net)) ourNow.add(k2(m.to, n));
    const remap = {}; const remapList = [];
    const busyOther = new Set(otherBusy.map((b) => k2(b.port, b.proto)));
    for (const c of plain) {
      const key = k2(c.port, c.proto);
      if (!ourNow.has(key) && !busyOther.has(key) && !need.has(key)) continue;
      if (remap[key]) continue;
      let to = 0;
      for (let i = 0; i < 500 && !to; i++) { const p = 20000 + Math.floor(Math.random() * 40000); if (![...taken, ...ourNow].includes(k2(p, c.proto))) to = p; }
      remap[key] = to; taken.add(k2(to, c.proto));
      remapList.push({ name: c.name, from: c.port, to, proto: c.proto });
    }
    for (const [key, who] of need) { const b = otherBusy.find((x) => k2(x.port, x.proto) === key); if (b) warnings.push(`${who} 要用的 ${key} 已经被 ${b.pname || '其他程序'} 占用，${who} 可能起不来`); }
    return { id: bid, apps: (info.meta.apps || []).map((a) => a.name), containers: info.containers.map((c) => String(c.Name || '').replace(/^\//, '')), moves, remap, remapList, warnings, needDocker: info.containers.length > 0 && !info.docker };
  }
  handle('server:restorePlan', (id, bid) => restorePlan(id, bid));
  handle('server:restoreBackup', async (id, bid, plan) => {
    const log = taskLogger('clean:' + id);
    if (!plan || plan.id !== bid) plan = await restorePlan(id, bid);
    // 先把 NodeDeck 的节点挪开并同步，腾出端口
    const moves = (plan.moves || []).filter((m) => core.PROTOCOLS[m.key] && Number.isInteger(m.to) && m.to > 0 && m.to < 65536);
    if (moves.length) {
      const cur = getServer(id);
      const protocols = { ...cur.protocols };
      for (const m of moves) { protocols[m.key] = { ...protocols[m.key], port: m.to }; log(`NodeDeck 的 ${m.label} 端口 ${m.from} 让给 ${m.who}，改用 ${m.to}`); }
      store.upsert('servers', { id, protocols });
      const errs = core.checkPortConflicts(state(), getServer(id));
      if (errs.length) { store.upsert('servers', { id, protocols: cur.protocols }); throw new Error('换端口失败：' + errs.join('；')); }
      await syncOne(id, log);
    }
    const remap = {};
    for (const [k, v] of Object.entries(plan.remap || {})) if (/^\d+\/(tcp|udp)$/.test(k) && Number.isInteger(v)) remap[k] = v;
    const info = await deploy.backupInfo(getServer(id), bid);
    await deploy.restoreBackup(getServer(id), bid, log, { containers: info.containers, remap });
    return { moves, remapList: plan.remapList || [] };
  });
  handle('server:deleteBackup', (id, bid) => deploy.deleteBackup(getServer(id), bid));
  // Reality 目标质量：VPS 上检测（四项 + 握手延迟 + 目标 IP）和这台电脑（国内）能不能连上，一起返回
  handle('server:realityQuality', async (id) => {
    const s = getServer(id);
    const rp = s.protocols?.vlessReality || {};
    const domain = rp.sni || s.realityState?.current;
    const [remote, local] = await Promise.all([
      deploy.remoteTlsCheck(s, domain).catch((e) => ({ ok: false, error: e.message, where: 'vps', at: Date.now() })),
      tools.realityCheck(domain).catch((e) => ({ ok: false, error: e.message, where: 'local', at: Date.now() })),
    ]);
    return { domain, source: rp.sniSource || '', auto: !!rp.sniAuto, vpsHost: s.host, remote, local, patrol: s.realityState || null };
  });
  handle('tools:reality', async (domain, serverId) => {
    const local = await tools.realityCheck(domain);
    let remote = null;
    if (serverId) { try { remote = await deploy.remoteTlsCheck(getServer(serverId), domain); } catch (e) { remote = { ok: false, error: e.message }; } }
    return { local, remote };
  });
  handle('tools:socks', (text) => tools.socksToQr(text));
  handle('tools:block', (host, port) => diagnose.blockCheck(sysFetch, host, port));
  handle('tools:localProxies', async () => (await proxy.localCandidates('')).map(proxy.proxyLabel));

  // 更新
  handle('update:check', () => updater.check(true));
  handle('update:download', () => updater.download());
  handle('update:install', () => updater.install());
  handle('update:status', () => updater.status);
  handle('app:changelog', () => readChangelog());

  // 备份
  handle('data:export', async () => {
    const r = await dialog.showSaveDialog(win, { title: '导出备份（包含服务器密码，请妥善保存）', defaultPath: `nodedeck-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(state(), null, 2));
    return r.filePath;
  });
  handle('data:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: '导入备份', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return false;
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!Array.isArray(data.servers) || !Array.isArray(data.users)) throw new Error('不是有效的 NodeDeck 备份');
    store.replaceAll(data);
    return true;
  });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  store = new Store();
  setProxyProvider(sshProxies);
  // 第一次连上某台服务器时记下 SSH 主机指纹，以后核对
  setHostKeySaver((srv, fp) => {
    // 直接改现有对象再保存（不用 upsert 换新对象：部署 / 同步途中手里拿着的服务器对象还要继续用）
    const cur = srv.id && state().servers.find((x) => x.id === srv.id);
    if (cur && cur.host === srv.host) { cur.hostKey = fp; store.save(); }
  });
  updater = new Updater((st) => send('update-status', st));
  registerIpc();
  createWindow();
  if (state().settings.autoUpdate !== false) updater.startSchedule(win);
  // 打开软件后每 10 分钟自动刷新一次流量和在用状态
  const tick = () => { if (state().servers.some((x) => x.deployedAt)) refreshUsage().then(() => send('usage-updated', Date.now())).catch(() => {}); };
  setTimeout(tick, 15000);
  setInterval(tick, 10 * 60 * 1000);
  setTimeout(() => blockWatchTick().catch(() => {}), 120000);
  setInterval(() => blockWatchTick().catch(() => {}), 30 * 60 * 1000);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => stock.closeAll());
