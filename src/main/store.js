'use strict';
// 本地数据：保存在 %APPDATA%/NodeDeck/data.bin，Windows 下用 DPAPI(safeStorage) 加密
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const core = require('./core');

const COLLECTIONS = ['servers', 'users', 'landings', 'forwards'];

function defaults() {
  return {
    version: 1,
    settings: {
      subPort: 2096,
      bwDefaultOff: true, // 新装用户：被墙巡检默认就是关，不需要迁移
      statsPort: 9092,
      adminPort: 9091,
      singboxBase: '',
      singboxAutoUpdate: true,
      autoUpdate: true,
      sshProxy: 'auto',
    },
    servers: [],
    landings: [],
    forwards: [],
    users: [core.newUser({ id: 'owner', name: '管理员（自用）', serverIds: '*', note: '默认用户，包含全部节点' })],
  };
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'data.bin');
    this.state = this.load();
    if (this.state.servers.length) { try { this.save(); } catch (_) { /* ignore */ } } // 保存迁移后的数据（如新协议的密钥）
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return defaults();
      const raw = fs.readFileSync(this.file);
      let text;
      if (raw.slice(0, 4).toString() === 'ND1:') text = safeStorage.decryptString(raw.slice(4));
      else text = raw.toString('utf8');
      const s = JSON.parse(text);
      const d = defaults();
      for (const srv of s.servers || []) {
        core.ensureProtocols(srv); // 旧数据补齐新协议
        // 0.6.3：记下已部署服务器当前在用的 Reality 目标，之后改了目标才需要重新检测
        const rp = srv.protocols?.vlessReality;
        if (srv.deployedAt && rp && rp.sniDeployed === undefined) rp.sniDeployed = rp.sni;
      }
      const st = s.settings || {};
      // 0.7.3：被墙巡检默认关；之前是「只提醒」（旧默认）的一并改成关，选了「自动换新」的保留
      if (!st.bwDefaultOff) { if (!st.blockWatch || st.blockWatch === 'notify') st.blockWatch = 'off'; st.bwDefaultOff = true; }
      return { ...d, ...s, settings: { ...d.settings, ...st } };
    } catch (e) {
      const bak = this.file + '.broken-' + Date.now();
      try { fs.copyFileSync(this.file, bak); } catch (_) { /* ignore */ }
      console.error('读取数据失败，已备份到', bak, e);
      return defaults();
    }
  }

  save() {
    const text = JSON.stringify(this.state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(tmp, Buffer.concat([Buffer.from('ND1:'), safeStorage.encryptString(text)]));
    else fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
  }

  upsert(col, item) {
    if (!COLLECTIONS.includes(col)) throw new Error('未知集合 ' + col);
    const list = this.state[col];
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = { ...list[i], ...item }; else list.push(item);
    this.save();
    return i >= 0 ? list[i] : item;
  }

  remove(col, id) {
    if (!COLLECTIONS.includes(col)) throw new Error('未知集合 ' + col);
    if (col === 'users' && id === 'owner') throw new Error('默认用户不能删除');
    this.state[col] = this.state[col].filter((x) => x.id !== id);
    if (col === 'servers') {
      this.state.forwards = this.state.forwards.filter((f) => f.relayServerId !== id && f.target?.serverId !== id);
      for (const u of this.state.users) {
        if (Array.isArray(u.serverIds)) u.serverIds = u.serverIds.filter((x) => x !== id);
        if (u.usage) delete u.usage[id];
      }
    }
    if (col === 'landings') {
      for (const s of this.state.servers) if (s.exit?.type === 'landing' && s.exit.landingId === id) s.exit = { type: 'direct' };
    }
    this.save();
  }

  setSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
  }

  replaceAll(data) {
    const d = defaults();
    this.state = { ...d, ...data, settings: { ...d.settings, ...(data.settings || {}) } };
    if (!this.state.users.find((u) => u.id === 'owner')) this.state.users.unshift(d.users[0]);
    this.save();
  }
}

module.exports = { Store };
