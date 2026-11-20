'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, net, session, shell, dialog, Menu } = require('electron');
const core = require('./core');
const tools = require('./tools');
const deploy = require('./deploy');
const nodetest = require('./nodetest');
const { Store } = require('./store');
const { Updater, publish } = require('./updater');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let store;
let updater;

const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
const singboxPath = path.join(resourcesDir, 'bin', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');

function defaultSingboxUrl() {
  const owner = publish.owner || 'YOUR_GITHUB_NAME';
  const repo = publish.repo || 'nodedeck';
  return `https://github.com/${owner}/${repo}/releases/latest/download/nodedeck-sing-box-linux-{arch}.gz`;
}

function state() {
  const s = store.state;
  if (!s.settings.singboxUrl) s.settings.singboxUrl = defaultSingboxUrl();
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

function sysFetch(url) { return net.fetch(url, { signal: AbortSignal.timeout(10000) }); }

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
  handle('app:info', () => ({ version: app.getVersion(), portable: !!process.env.PORTABLE_EXECUTABLE_DIR, repo: publish.owner ? `${publish.owner}/${publish.repo}` : '', singbox: fs.existsSync(singboxPath), dataDir: app.getPath('userData') }));
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
    return nodetest.testOutbound({ singboxPath, outbound: core.clientOutbound(s, entry, user), fetchVia });
  });
  handle('landing:test', async (id) => {
    if (!fs.existsSync(singboxPath)) throw new Error('找不到内置 sing-box：' + singboxPath);
    const l = state().landings.find((x) => x.id === id);
    if (!l) throw new Error('落地不存在');
    return nodetest.testOutbound({ singboxPath, outbound: core.landingOutbound(l, 'proxy'), fetchVia });
  });
  handle('qr', (text) => tools.qr(text));

  // 服务器
  handle('server:testSsh', (srv) => deploy.testSSH(srv));
  handle('server:deploy', async (id) => {
    const srv = getServer(id);
    const st = await deploy.deployServer(state(), srv, { resourcesDir, log: taskLogger('deploy:' + id) });
    store.upsert('servers', { id, deployedAt: Date.now(), lastStatus: st });
    return st;
  });
  handle('server:sync', async (id) => {
    const srv = getServer(id);
    const st = await deploy.syncServer(state(), srv, { log: taskLogger('sync:' + id) });
    store.upsert('servers', { id, lastStatus: st, syncedAt: Date.now() });
    return st;
  });
  handle('server:syncAll', async () => {
    const results = [];
    for (const srv of state().servers.filter((x) => x.deployedAt)) {
      try {
        const st = await deploy.syncServer(state(), srv);
        store.upsert('servers', { id: srv.id, lastStatus: st, syncedAt: Date.now() });
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
    return { url, clashUrl: url ? url + '?format=clash' : '', links: sub.links, qr: url ? await tools.qr(url) : null, status: core.userStatus(u), used: core.userUsedBytes(u) };
  });
  handle('users:refreshUsage', async () => {
    const s = state();
    const errors = [];
    for (const srv of s.servers.filter((x) => x.deployedAt)) {
      try {
        const st = await deploy.fetchStats(srv, s);
        for (const u of s.users) {
          if (!core.userHasServer(u, srv.id)) continue;
          const t = st.traffic?.[u.id] || { up: 0, down: 0 };
          u.usage = { ...(u.usage || {}), [srv.id]: { up: t.up || 0, down: t.down || 0 } };
        }
      } catch (e) { errors.push(`${srv.name}: ${e.message}`); }
    }
    store.save();
    return { errors, users: state().users };
  });
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

  // 更新
  handle('update:check', () => updater.check(true));
  handle('update:download', () => updater.download());
  handle('update:install', () => updater.install());
  handle('update:status', () => updater.status);

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
  updater = new Updater((st) => send('update-status', st));
  registerIpc();
  createWindow();
  if (state().settings.autoUpdate !== false) updater.startSchedule(win);
});
app.on('window-all-closed', () => app.quit());
