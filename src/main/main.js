'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, net, session, shell, dialog, Menu } = require('electron');
const core = require('./core');
const tools = require('./tools');
const deploy = require('./deploy');
const nodetest = require('./nodetest');
const diagnose = require('./diagnose');
const links = require('./links');
const proxy = require('./proxy');
const { setProxyProvider } = require('./ssh');
const { Store } = require('./store');
const { Updater, publish } = require('./updater');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let store;
let updater;

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
const singboxPath = path.join(resourcesDir, 'bin', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');

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
function taskLogger(task) { return (line) => send('task-log', { task, line: String(line), time: Date.now() }); }

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
    return nodetest.testOutbound({ singboxPath, outbound: core.clientOutbound(s, entry, user), fetchVia });
  };
}

function appVersionForAgent() { return app.isPackaged ? app.getVersion() : ''; }

async function syncOne(id, log) {
  const st = await deploy.syncServer(state(), getServer(id), { log, resourcesDir, appVersion: appVersionForAgent() });
  store.upsert('servers', { id, lastStatus: st, syncedAt: Date.now() });
  return st;
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
    return { errors, users: state().users };
  })();
  try { return await refreshing; } finally { refreshing = null; }
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
    backgroundColor: '#0b1020',
    title: `NodeDeck ${app.getVersion()}`,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
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
  handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, portable: !!process.env.PORTABLE_EXECUTABLE_DIR, repo: publish.owner ? `${publish.owner}/${publish.repo}` : '', singbox: fs.existsSync(singboxPath), dataDir: app.getPath('userData') }));
  handle('state:get', () => state());
  handle('col:upsert', (col, item) => store.upsert(col, item));
  handle('col:remove', (col, id) => store.remove(col, id));
  handle('settings:set', (patch) => { store.setSettings(patch); return state().settings; });
  handle('new:server', (fields) => core.newServer(fields));
  handle('new:user', (fields) => core.newUser(fields));
  handle('new:reality', () => core.realityKeypair());
  handle('open:external', (url) => shell.openExternal(url));

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
    const srv = getServer(id);
    const log = taskLogger('deploy:' + id);
    const st = await deploy.deployServer(state(), srv, { resourcesDir, log });
    store.upsert('servers', { id, deployedAt: Date.now(), lastStatus: st });
    let portChanges = [];
    try { portChanges = await autoFixPorts(id, log); } catch (e) { log('端口自测出错：' + e.message); }
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
  updater = new Updater((st) => send('update-status', st));
  registerIpc();
  createWindow();
  if (state().settings.autoUpdate !== false) updater.startSchedule(win);
  // 打开软件后每 10 分钟自动刷新一次流量和在用状态
  const tick = () => { if (state().servers.some((x) => x.deployedAt)) refreshUsage().then(() => send('usage-updated', Date.now())).catch(() => {}); };
  setTimeout(tick, 15000);
  setInterval(tick, 10 * 60 * 1000);
});
app.on('window-all-closed', () => app.quit());
