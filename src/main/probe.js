'use strict';
// 探针网页（只读）：选一台 VPS 当主控，它的 agent 定时从各台 agent 拉数据，在订阅端口 /p/<口令>/ 出网页；
// 某台 1 分钟连不上就发 Telegram，恢复后再发一次。网页和接口里不出现 IP，没有任何远程操作功能。
const crypto = require('crypto');
const core = require('./core');
const notify = require('./notify');

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

function cfg(state) { return state.settings?.probe || {}; }
function hostOf(state) {
  const p = cfg(state);
  return (state.servers || []).find((s) => s.id === p.hostId && s.deployedAt) || null;
}
function probeOn(state) { return !!(cfg(state).enabled && hostOf(state)); }

// 开启时补齐口令和各台的只读密钥（会修改 state，调用方负责保存）；返回是否有改动
function ensureKeys(state) {
  const p = cfg(state);
  if (!p.enabled) return false;
  let changed = false;
  if (!p.token) { p.token = rand(18); changed = true; }
  for (const s of state.servers || []) if (!s.probeKey) { s.probeKey = rand(24); changed = true; }
  return changed;
}

function peers(state) {
  const p = cfg(state);
  const hidden = new Set(p.hidden || []);
  const port = state.settings?.subPort || 2096;
  return (state.servers || []).filter((s) => s.deployedAt && !hidden.has(s.id) && s.probeKey).map((s, i) => ({
    id: s.id,
    name: s.name || s.host,
    cc: s.geo?.cc || '',
    addr: `${core.hostForUri(String(s.host).trim())}:${port}`,
    key: s.probeKey,
    self: s.id === p.hostId,
    expireAt: s.vpsExpireAt ? Math.floor(s.vpsExpireAt / 1000) : 0,
    quotaGB: Number(s.quotaGB) || 0,
    memMB: s.hw?.memMB || 0,
    group: s.group || '',
    order: i,
  }));
}

function hostCfg(state) {
  const p = cfg(state);
  return { token: p.token, title: p.title || '服务器状态', alert: p.alert !== false, peers: peers(state) };
}

// 写进 agent.json 的部分：没开探针返回 null（agent 就不提供 /probe/data）
function agentCfg(state, server) {
  if (!probeOn(state) || !server.probeKey) return null;
  const out = { key: server.probeKey };
  if (server.id === cfg(state).hostId) out.host = hostCfg(state);
  return out;
}

// 主控上的机器列表是不是最新的（加了 / 删了 / 改名服务器后要同步一下主控）
function hostSig(state) { return crypto.createHash('sha256').update(JSON.stringify(hostCfg(state))).digest('hex').slice(0, 16); }

function url(state) {
  const h = hostOf(state);
  if (!h || !cfg(state).token) return '';
  const port = state.settings?.subPort || 2096;
  return `${core.subBase(h.host, port, core.subCertOk(state, h))}/p/${cfg(state).token}/`;
}

function info(state) {
  const p = cfg(state);
  const h = hostOf(state);
  const rows = h?.lastStatus?.probe?.peers || [];
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  return {
    enabled: !!p.enabled,
    on: probeOn(state),
    hostId: p.hostId || '',
    hostName: h?.name || '',
    url: url(state),
    https: !!(h && core.subCertOk(state, h)),
    stale: !!(probeOn(state) && h.probeSig !== hostSig(state)),
    notifyOn: notify.anyOn(state.settings), channels: notify.channels(state.settings),
    peers: peers(state).map((x) => ({ id: x.id, name: x.name, ...(byId[x.id] ? { online: byId[x.id].online, error: byId[x.id].error || '' } : {}) })),
  };
}

module.exports = { probeOn, ensureKeys, peers, hostCfg, agentCfg, hostSig, url, info, hostOf };
