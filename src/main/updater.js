'use strict';
// 自动更新：安装版用 electron-updater（GitHub Releases），便携版检测到新版后引导下载
const fs = require('fs');
const path = require('path');
const { app, net, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const pkg = require('../../package.json');

// 打包后 package.json 里的 build 字段会被去掉，仓库信息要从 electron-builder 生成的 app-update.yml 读
function readPublish() {
  if (app.isPackaged) {
    try {
      const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
      const get = (k) => (yml.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (get('owner') && get('repo')) return { provider: 'github', owner: get('owner'), repo: get('repo') };
    } catch (_) { /* ignore */ }
  }
  return (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {};
}
const publish = readPublish();
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

class Updater {
  constructor(send) {
    this.send = send; // (status) => void
    this.status = { state: 'idle', current: app.getVersion(), portable: isPortable };
    this.lastCheck = 0;
    this.portableAsset = null;
    if (!isPortable) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
      autoUpdater.on('update-available', (info) => this.set({ state: 'available', latest: info.version, notes: info.releaseNotes || '' }));
      autoUpdater.on('update-not-available', (info) => this.set({ state: 'latest', latest: info.version }));
      autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }));
      autoUpdater.on('update-downloaded', (info) => this.set({ state: 'downloaded', latest: info.version }));
      autoUpdater.on('error', (e) => this.set({ state: 'error', error: String(e && e.message ? e.message : e).slice(0, 300) }));
    }
  }

  set(patch) { this.status = { ...this.status, ...patch }; this.send(this.status); }

  get configured() { return publish.owner && publish.owner !== 'YOUR_GITHUB_NAME'; }

  async check(manual = false) {
    if (!app.isPackaged) { this.set({ state: 'dev', error: '开发模式下不检查更新' }); return this.status; }
    if (!this.configured) { this.set({ state: 'error', error: 'package.json 里还没填 GitHub 仓库（build.publish）' }); return this.status; }
    if (!manual && Date.now() - this.lastCheck < 5 * 60 * 1000) return this.status;
    this.lastCheck = Date.now();
    try {
      if (!isPortable) { await autoUpdater.checkForUpdates(); return this.status; }
      this.set({ state: 'checking' });
      const r = await net.fetch(`https://api.github.com/repos/${publish.owner}/${publish.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('GitHub 返回 ' + r.status);
      const rel = await r.json();
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      this.portableAsset = (rel.assets || []).find((a) => /portable/i.test(a.name)) || null;
      this.releaseUrl = rel.html_url;
      this.set(cmpVer(latest, app.getVersion()) > 0 ? { state: 'available', latest, notes: rel.body || '' } : { state: 'latest', latest });
    } catch (e) {
      this.set({ state: 'error', error: '检查更新失败（需要能访问 GitHub，国内请先开代理）：' + e.message });
    }
    return this.status;
  }

  async download() {
    if (isPortable) {
      shell.openExternal(this.portableAsset ? this.portableAsset.browser_download_url : this.releaseUrl || `https://github.com/${publish.owner}/${publish.repo}/releases/latest`);
      return this.status;
    }
    this.set({ state: 'downloading', percent: 0 });
    try { await autoUpdater.downloadUpdate(); } catch (e) { this.set({ state: 'error', error: e.message }); }
    return this.status;
  }

  install() { if (!isPortable) autoUpdater.quitAndInstall(false, true); }

  startSchedule(win) {
    setTimeout(() => this.check(), 10 * 1000);
    setInterval(() => this.check(), 30 * 60 * 1000);
    win.on('focus', () => this.check());
  }
}

module.exports = { Updater, publish };
