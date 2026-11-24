'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
/* global api */ // 由 preload.js 注入

const PROTOS = [
  ['vlessReality', 'VLESS-Reality', 'tcp'],
  ['trojan', 'Trojan', 'tcp'],
  ['vmess', 'VMess-WS', 'tcp'],
  ['hysteria2', 'Hysteria2', 'udp'],
  ['tuic', 'TUIC v5', 'udp'],
  ['anytls', 'AnyTLS', 'tcp'],
  ['shadowsocks', 'Shadowsocks-2022', 'tcp+udp'],
];
const WARP_SITE_LABELS = { openai: 'ChatGPT / OpenAI', anthropic: 'Claude', google: 'Google / Gemini', netflix: 'Netflix', disney: 'Disney+', spotify: 'Spotify', tiktok: 'TikTok' };
function randStr(n = 16) { const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let r = ''; const a = crypto.getRandomValues(new Uint8Array(n)); for (const x of a) r += c[x % c.length]; return r; }
const PROTO_LABEL = Object.fromEntries(PROTOS.map(([k, l]) => [k, l]));
const GB = 1024 ** 3;

let S = null; // 全量状态
let info = {};
let updateStatus = {};
let dirty = false;
let snoozed = false;
let page = 'dash';

const NAV_ICONS = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.5"/></svg>',
  servers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="6.5" rx="1.8"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8"/><circle cx="7.5" cy="7.25" r=".9" fill="currentColor"/><circle cx="7.5" cy="16.75" r=".9" fill="currentColor"/><path d="M12 7.25h5M12 16.75h5"/></svg>',
  nodes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M7.8 16.6 16.2 7.4M8.2 18h7.6"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.8c1.6.6 2.6 2.2 3 4.7"/></svg>',
  landings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  forwards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/></svg>',
  tools: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5a4 4 0 0 0 5 5L13 18a2.1 2.1 0 0 1-3-3l6.5-6.5"/><path d="M5 19l3-3M4 5l5 5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/></svg>',
};
const PAGES = [
  ['dash', NAV_ICONS.dash, '概览'],
  ['servers', NAV_ICONS.servers, '服务器'],
  ['nodes', NAV_ICONS.nodes, '节点'],
  ['users', NAV_ICONS.users, '用户'],
  ['landings', NAV_ICONS.landings, '落地'],
  ['forwards', NAV_ICONS.forwards, '中转 / 隧道'],
  ['tools', NAV_ICONS.tools, '工具箱'],
  ['settings', NAV_ICONS.settings, '设置'],
];

// Reality 目标检测结果：本机和 VPS 分两列，各自带检测时间。能不能用以 VPS 为准（Reality 是 VPS 去连目标网站）
function realityResultTable(local, remote) {
  const cols = [remote && ['VPS（以此为准）', remote], local && ['本机（仅供参考）', local]].filter(Boolean);
  const names = ['TLS 1.3', 'HTTP/2', 'X25519', '证书有效'];
  const cell = (r, n) => {
    if (!r.checks) return n === names[0] ? h('span', { class: 'tag bad' }, r.error || '失败') : '';
    const c = r.checks.find((x) => x.name === n);
    return c ? h('span', { class: 'tag ' + (c.ok ? 'ok' : 'bad'), title: c.value }, c.ok ? '通过' : '不通过') : '';
  };
  return h('table', { class: 'checktab' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), cols.map(([t, r]) => h('th', {}, t, h('div', { class: 'muted', style: { fontWeight: 400 } }, `${fmtDate(r.at)}${r.ms ? ` · ${r.ms} ms` : ''}`))))),
    h('tbody', {}, names.map((n) => h('tr', {}, h('td', { class: 'muted' }, n), cols.map(([, r]) => h('td', {}, cell(r, n))))),
      h('tr', {}, h('td', { class: 'muted' }, '结论'), cols.map(([, r]) => h('td', {}, h('b', { style: { color: r.ok ? 'var(--ok)' : 'var(--danger)' } }, r.ok ? '可以用' : '不能用'))))));
}

// Reality 主流目标的中文名（列表本身来自 core.REALITY_FALLBACKS）
const REALITY_NAMES = { 'www.microsoft.com': '微软', 'www.apple.com': '苹果', 'www.nvidia.com': '英伟达', 'www.amazon.com': '亚马逊', 'www.samsung.com': '三星', 'www.tesla.com': '特斯拉', 'www.oracle.com': '甲骨文', 'www.cisco.com': '思科', 'addons.mozilla.org': 'Mozilla 扩展商店' };

// 外观：跟随系统 / 浅色 / 深色
const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = (S.settings && S.settings.theme) || 'system';
  const dark = pref === 'dark' || (pref === 'system' && darkMQ.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
darkMQ.addEventListener('change', applyTheme);

async function reload() { S = await api.call('state:get'); }
function markDirty() { dirty = true; renderBanner(); }
const serverName = (id) => S.servers.find((s) => s.id === id)?.name || '（已删除）';

function userUsed(u) { return Object.values(u.usage || {}).reduce((a, v) => a + (v.up || 0) + (v.down || 0), 0); }
function userExpire(u) {
  if (u.expireAfterDays > 0) return u.firstUsedAt ? u.firstUsedAt + u.expireAfterDays * 86400000 : null;
  return u.expireAt || null;
}
function userState(u) {
  const exp = userExpire(u);
  if (!u.enabled) return ['已停用', 'bad'];
  if (exp && Date.now() >= exp) return ['已到期', 'bad'];
  if (u.limitGB > 0 && userUsed(u) >= u.limitGB * GB) return ['流量用尽', 'bad'];
  if (u.expireAfterDays > 0 && !u.firstUsedAt) return ['未启用', 'blue'];
  if (exp && exp - Date.now() < 3 * 86400000) return ['即将到期', 'warn'];
  return ['正常', 'ok'];
}
const RESET_LABEL = { none: '不重置', day: '每天', week: '每周一', month: '每月', rolling30: '每 30 天' };
function ago(ms) {
  const d = Date.now() - ms;
  if (d < 90 * 1000) return '刚刚';
  if (d < 3600 * 1000) return Math.round(d / 60000) + ' 分钟前';
  if (d < 86400 * 1000) return Math.round(d / 3600000) + ' 小时前';
  return Math.round(d / 86400000) + ' 天前';
}

// ---------- 框架 ----------
function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const [id, ico, label] of PAGES) {
    nav.append(h('a', { class: page === id ? 'active' : '', title: label, onclick: () => go(id) }, h('span', { class: 'ico', html: ico }), h('span', {}, label)));
  }
  renderFoot();
}

function renderFoot() {
  const f = document.getElementById('sideFoot');
  f.innerHTML = '';
  f.append(h('div', {}, `v${info.version || ''}${info.portable ? ' 便携版' : ''}`));
  const st = updateStatus.state;
  if (st === 'available') f.append(h('div', { class: 'upd', onclick: () => go('settings') }, `● 新版本 ${updateStatus.latest}`));
  if (st === 'downloading') f.append(h('div', { class: 'upd' }, `下载更新 ${updateStatus.percent || 0}%`), h('div', { class: 'upd-bar' }, h('i', { style: { width: (updateStatus.percent || 0) + '%' } })));
  if (st === 'downloaded') f.append(h('div', { class: 'upd', onclick: () => api.call('update:install') }, '● 更新已就绪，点此重启'));
}

let updSnoozed = false;
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round((b || 0) / 1024) + ' KB');
// 下载进度：进度条 + 已下载 / 总大小 + 速度 + 剩余时间
function updProgress(u) {
  const pct = Math.max(0, Math.min(100, u.percent || 0));
  const left = u.speed > 0 && u.total > u.transferred ? Math.ceil((u.total - u.transferred) / u.speed) : 0;
  const parts = [`${pct}%`];
  if (u.total) parts.push(`${fmtSize(u.transferred)} / ${fmtSize(u.total)}`);
  if (u.speed) parts.push(`${fmtSize(u.speed)}/s`);
  if (left) parts.push(left >= 60 ? `还剩约 ${Math.ceil(left / 60)} 分钟` : `还剩约 ${left} 秒`);
  return h('div', { class: 'upd-progress' }, h('div', { class: 'upd-bar' }, h('i', { style: { width: pct + '%' } })), h('div', { class: 'muted', style: { fontSize: '12px' } }, u.total || pct ? parts.join(' · ') : '正在连接 GitHub …'));
}
function plainNotes(t) { return String(t || '').replace(/<li[^>]*>/gi, '• ').replace(/<\/(li|p|h\d|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim(); }

function renderBanner() {
  const b = document.getElementById('banner');
  b.innerHTML = '';
  const u = updateStatus;
  if (u.state === 'downloading' && !updSnoozed) {
    b.classList.remove('hidden');
    b.append(h('div', { style: { flex: 1 } }, h('b', {}, `正在下载新版本 ${u.latest || ''}`), updProgress(u)),
      h('button', { class: 'small', onclick: () => { updSnoozed = true; renderBanner(); } }, '后台下载'));
    return;
  }
  if (u.state === 'downloaded' && u.latest) {
    // 下载好了总是提示（之前点过「稍后」也提示），装的时候不弹安装向导
    b.classList.remove('hidden');
    b.append(h('div', { style: { flex: 1 } }, h('b', {}, `新版本 ${u.latest} 已下载好`), h('div', { class: 'notes' }, '点「重启并更新」会在后台自动安装（不弹安装窗口），十几秒后自动重新打开。不想现在重启的话，下次关闭软件时也会自动装好')),
      h('button', { class: 'small primary', onclick: () => api.call('update:install') }, '重启并更新'),
      h('button', { class: 'small', onclick: () => { b.classList.add('hidden'); } }, '稍后'));
    return;
  }
  if (u.state === 'available' && u.latest && u.latest !== S.settings.skipVersion && !updSnoozed) {
    b.classList.remove('hidden');
    const notes = plainNotes(u.notes);
    b.append(h('div', { style: { flex: 1 } }, h('b', {}, `发现新版本 ${u.latest}`), notes ? h('div', { class: 'notes' }, notes) : null),
      h('button', { class: 'small primary', onclick: () => { api.call('update:download'); } }, info.portable ? '下载新版' : '立即更新'),
      h('button', { class: 'small', onclick: async () => { await api.call('settings:set', { skipVersion: u.latest }); S.settings.skipVersion = u.latest; renderBanner(); toast('这一版不再提醒，有更新的版本时会再提示；也可以在「设置」里手动更新'); } }, '这一版不再提醒'),
      h('button', { class: 'small', onclick: () => { updSnoozed = true; renderBanner(); } }, '稍后'));
    return;
  }
  const outdated = S.servers.filter(agentOutdated).length;
  if ((!dirty && (!outdated || snoozed)) || !S.servers.some((s) => s.deployedAt)) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.append(h('span', {}, dirty ? '配置已修改，需要同步到服务器才会生效。' : `软件已更新，${outdated} 台服务器的 agent 需要升级。`),
    h('button', { class: 'small primary', onclick: (e) => busy(e.currentTarget, syncAll) }, '同步全部服务器'),
    h('button', { class: 'small', onclick: () => { dirty = false; snoozed = true; renderBanner(); } }, '稍后'));
}

async function syncAll() {
  const r = await api.call('server:syncAll');
  const bad = r.filter((x) => !x.ok);
  if (bad.length === r.length && r.length) toast('同步失败：\n' + bad.map((x) => `${x.name}: ${x.error}`).join('\n'), 'err');
  else if (bad.length) toast(`部分成功：${r.length - bad.length} 台已同步，${bad.length} 台失败\n` + bad.map((x) => `${x.name}: ${x.error}`).join('\n'), 'warn');
  else toast(r.length ? `已同步 ${r.length} 台服务器` : '没有已部署的服务器', 'ok');
  if (!bad.length) dirty = false;
  await reload(); renderBanner();
  if (['servers', 'dash'].includes(page)) render();
}

async function go(p) { page = p; renderNav(); await render(); }

async function render() {
  // 每次渲染用一个新容器：连续触发两次渲染时，旧的那次写到已被移除的容器里，不会重复显示
  const v = document.getElementById('view');
  const box = h('div', { class: 'view-inner' });
  v.innerHTML = '';
  v.append(box);
  try { await VIEWS[page](box); } catch (e) { box.append(h('div', { class: 'card' }, '出错了：' + e.message)); }
}

// ---------- 概览 ----------
async function viewDash(v) {
  await reload();
  const deployed = S.servers.filter((s) => s.deployedAt);
  const nodes = (await api.call('nodes:list')).reduce((a, g) => a + g.entries.length, 0);
  const activeUsers = S.users.filter((u) => userState(u)[1] !== 'bad').length;
  const traffic = S.users.reduce((a, u) => a + userUsed(u), 0);
  const running = deployed.filter((s) => s.lastStatus?.singbox && s.lastStatus?.agent).length;
  const [tv, tu] = fmtBytes(traffic).split(' ');
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '概览'), h('p', { class: 'sub' }, deployed.length ? `${running} 台在运行${deployed.length > running ? `，${deployed.length - running} 台需要看一下` : ''}` : '先添加一台 VPS，部署后就能生成节点和订阅')), h('div', { class: 'spacer' }),
    deployed.length ? h('button', { onclick: (e) => busy(e.currentTarget, async () => { await api.call('users:refreshUsage'); toast('已刷新', 'ok'); render(); }) }, '刷新') : null,
    h('button', { class: 'primary', onclick: () => editServer() }, '添加服务器')));
  v.append(h('div', { class: 'statstrip' },
    h('div', {}, h('div', { class: 'n' }, running, h('small', {}, ` / ${S.servers.length}`)), h('div', { class: 'l' }, '运行中 / 服务器')),
    h('div', {}, h('div', { class: 'n' }, nodes), h('div', { class: 'l' }, '节点入口')),
    h('div', {}, h('div', { class: 'n' }, activeUsers, h('small', {}, ` / ${S.users.length}`)), h('div', { class: 'l' }, '可用用户 / 全部')),
    h('div', {}, h('div', { class: 'n' }, tv, h('small', {}, ' ' + (tu || ''))), h('div', { class: 'l' }, '本周期累计流量'))));

  if (!S.servers.length) {
    v.append(h('div', { class: 'card' }, h('h3', {}, '从这里开始'),
      h('ol', { style: { lineHeight: '2.1', margin: '0 0 14px', paddingLeft: '20px' } },
        h('li', {}, '在「服务器」里添加 VPS（IP 和 root 密码），点「部署」'),
        h('li', {}, '在「节点」里复制链接或扫码，点「测试」看延迟和出口 IP'),
        h('li', {}, '在「用户」里创建用户，设置流量和到期时间，把订阅地址发给对方'),
        h('li', {}, '需要住宅 IP 出口：在「落地」添加，再在服务器设置里选出口'),
        h('li', {}, '节点被墙：一键换新，或在「中转 / 隧道」用另一台 VPS 转发')),
      h('button', { class: 'primary', onclick: () => editServer() }, '添加第一台服务器')));
  } else {
    const box = h('div', { class: 'lines' }, h('div', { class: 'lines-head' }, h('h3', {}, '线路'), h('div', { class: 'spacer' }), h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('servers'); } }, '管理服务器')));
    for (const s of S.servers) {
      const st = s.lastStatus;
      const cls = !s.deployedAt ? 'idle' : st && st.singbox && st.agent ? (s.realityState?.fails > 0 || agentOutdated(s) ? 'warn' : 'ok') : 'bad';
      const label = { idle: h('span', { class: 'tag' }, '未部署'), ok: h('span', { class: 'tag ok' }, '运行中'), warn: h('span', { class: 'tag warn' }, s.realityState?.fails > 0 ? 'Reality 目标异常' : 'agent 待升级'), bad: h('span', { class: 'tag bad' }, '异常') }[cls];
      const protos = PROTOS.filter(([k]) => s.protocols?.[k]?.enabled).map(([, l]) => l);
      const today = s.lastStats?.today;
      box.append(h('div', { class: 'line-row ' + cls },
        h('div', { class: 'strip' }),
        h('div', { class: 'name' }, h('b', {}, s.name), h('span', { class: 'mono muted' }, s.host)),
        h('div', {}, label, h('span', { class: 'cap' }, protos.join(' · ') || '没有开启协议')),
        h('div', { class: 'hide-narrow' }, h('div', { class: 'num' }, today ? fmtBytes((today.up || 0) + (today.down || 0)) : '—'), h('div', { class: 'cap' }, '今日流量')),
        h('div', { class: 'hide-narrow' }, s.vpsExpireAt ? [h('div', { class: 'num' }, `${Math.max(0, Math.ceil((s.vpsExpireAt - Date.now()) / 86400000))} 天`), h('div', { class: 'cap' }, 'VPS 剩余')] : [h('div', { class: 'num muted' }, '—'), h('div', { class: 'cap' }, 'VPS 到期未填')]),
        h('div', { class: 'actions' },
          !s.deployedAt ? h('button', { class: 'small primary', onclick: () => deployServer(s) }, '部署') : null,
          s.deployedAt ? h('button', { class: 'small', onclick: () => showMonitor(s) }, '监控') : null,
          s.deployedAt ? h('button', { class: 'small', onclick: () => diagnoseServer(s) }, '体检') : null)));
    }
    v.append(box);
  }
  if (['available', 'downloaded'].includes(updateStatus.state)) v.append(updateCard());
}
function stat(n, l) { return h('div', { class: 'card stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)); }

// ---------- 服务器 ----------
function agentOutdated(s) {
  const v = s.lastStatus?.agentVersion;
  return !!(s.deployedAt && v && info.packaged && v !== info.version);
}

async function viewServers(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '服务器'), h('p', { class: 'sub' }, '通过 SSH 安装 sing-box 和 agent，一键部署 7 种协议')), h('div', { class: 'spacer' }),
    h('button', { onclick: (e) => busy(e.currentTarget, syncAll) }, '同步全部'),
    h('button', { class: 'primary', onclick: () => editServer() }, '+ 添加服务器')));
  if (!S.servers.length) { v.append(h('div', { class: 'card empty' }, '还没有服务器，点右上角添加')); return; }
  for (const id of [...serverSel]) if (!S.servers.some((x) => x.id === id)) serverSel.delete(id);
  const n = serverSel.size;
  if (n) v.append(h('div', { class: 'toolbar', style: { marginBottom: '8px' } }, h('div', { class: 'spacer' }), h('span', { class: 'muted' }, `已选 ${n} 台`),
    h('button', { class: 'small', onclick: (e) => menu(e.currentTarget, [
      { label: '同步', onClick: () => serverBatch('sync') },
      { label: '一键换新（换端口和密钥）', onClick: async () => { if (await confirmBox(`给选中的 ${n} 台服务器一键换新？用户需要刷新订阅。`)) serverBatch('rotate'); } },
      { label: 'Reality 目标：自动重新优选', onClick: () => serverBatch('realitySni', '__auto__') },
      { label: 'Reality 目标：统一改成…', onClick: async () => { const d = await promptText('统一 Reality 目标', '目标网站域名', 'www.microsoft.com'); if (d) serverBatch('realitySni', d); } },
      { label: '路由规则：开启屏蔽 BT', onClick: () => serverBatch('routing', { blockBT: true }) },
      { label: '路由规则：关闭屏蔽 BT', onClick: () => serverBatch('routing', { blockBT: false }) },
      { label: '路由规则：开启屏蔽广告', onClick: () => serverBatch('routing', { blockAds: true }) },
      { label: '路由规则：关闭屏蔽广告', onClick: () => serverBatch('routing', { blockAds: false }) },
      { label: '路由规则：禁止访问国内网站', onClick: () => serverBatch('routing', { blockCN: true }) },
      { label: '路由规则：允许访问国内网站', onClick: () => serverBatch('routing', { blockCN: false }) },
    ]) }, '批量操作 ▾'),
    h('button', { class: 'small', onclick: () => { serverSel.clear(); render(); } }, '取消选择')));
  const allCb = h('input', { type: 'checkbox', checked: S.servers.every((x) => serverSel.has(x.id)) });
  allCb.onchange = () => { for (const x of S.servers) allCb.checked ? serverSel.add(x.id) : serverSel.delete(x.id); render(); };
  const tb = h('tbody');
  for (const s of S.servers) {
    const cb = h('input', { type: 'checkbox', checked: serverSel.has(s.id) });
    cb.onchange = () => { cb.checked ? serverSel.add(s.id) : serverSel.delete(s.id); render(); };
    const rs = s.realityState;
    const realityTag = s.protocols?.vlessReality?.enabled && rs?.fails > 0 ? h('span', { class: 'tag warn', title: rs.lastErr || '' }, `Reality 目标异常 ×${rs.fails}`) : null;
    const st = s.lastStatus;
    const status = !s.deployedAt ? h('span', { class: 'tag' }, '未部署') : st && st.singbox && st.agent ? h('span', { class: 'tag ok' }, '运行中') : h('span', { class: 'tag bad' }, '异常');
    const protos = PROTOS.filter(([k]) => s.protocols?.[k]?.enabled).map(([k, l]) => h('span', { class: 'tag' }, `${l}:${s.protocols[k].port}`));
    const exit = s.exit?.type === 'landing' ? h('span', { class: 'tag blue' }, '落地: ' + (S.landings.find((l) => l.id === s.exit.landingId)?.name || '?')) : h('span', { class: 'tag' }, '直连');
    const fw = S.forwards.filter((f) => f.relayServerId === s.id).length;
    const lamp = !s.deployedAt ? 'idle' : st && st.singbox && st.agent ? 'ok' : 'bad';
    tb.append(h('tr', { class: 'lamp-' + lamp },
      h('td', { style: { width: '28px' } }, cb),
      h('td', {}, h('b', {}, s.name), h('div', { class: 'muted mono', style: { wordBreak: 'normal', whiteSpace: 'nowrap' } }, s.host), hwLine(s), realityTag, s.role === 'relay' ? h('span', { class: 'tag blue' }, '中转机') : null, vpsExpireTag(s), core_cf(s) && s.deployedAt ? h('span', { class: 'tag ' + (s.lastStatus?.cf ? 'blue' : 'warn'), title: s.lastStatus?.cf ? '' : '隧道服务没在运行：检查令牌是否正确、VPS 能否连上 Cloudflare' }, s.lastStatus?.cf ? 'CF 隧道' : 'CF 隧道未连通') : null),
      h('td', {}, status, agentOutdated(s) ? h('span', { class: 'tag warn', title: '点「同步」自动升级' }, 'agent 待升级') : null, st?.version ? h('div', { class: 'muted' }, 'sing-box ' + st.version) : null, st?.mem ? h('div', { class: 'muted' }, `内存 ${st.mem} · 负载 ${st.load}`) : null),
      h('td', {}, protos.length ? protos : h('span', { class: 'muted' }, '无'), fw ? h('span', { class: 'tag blue' }, `转发 ${fw}`) : null),
      h('td', {}, exit),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: () => deployServer(s) }, s.deployedAt ? '重新部署' : '部署'),
        s.deployedAt ? h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, async () => { await api.call('server:sync', s.id); toast('已同步', 'ok'); dirty = false; renderBanner(); render(); }) }, '同步') : null,
        h('button', { class: 'small', title: '一步步检查 SSH、服务、端口、是否被墙、节点真连', onclick: () => diagnoseServer(s) }, '体检'),
        h('button', { class: 'small', onclick: () => editServer(s) }, '编辑'),
        h('button', { class: 'small', onclick: (e) => menu(e.currentTarget, [
          s.deployedAt && { label: '监控面板', onClick: () => showMonitor(s) },
          s.deployedAt && { label: '网络优化（线路 / 测速 / BBR）', onClick: () => showNetLab(s) },
          s.deployedAt && { label: '刷新状态', onClick: async () => { await api.call('server:status', s.id); toast('已刷新', 'ok'); render(); } },
          s.deployedAt && { label: '查看日志', onClick: () => showLogs(s) },
          s.deployedAt && { label: '升级 sing-box 内核', onClick: async () => { toast('正在检查内核更新…'); const m = await api.call('server:updateSingbox', s.id); toast(m, 'ok'); render(); } },
          { label: '一键换新（被墙时用）', onClick: () => rotateServer(s) },
          s.deployedAt && s.protocols?.vlessReality?.enabled && { label: '重新优选 Reality 目标', onClick: () => repickReality(s) },
          s.deployedAt && s.protocols?.vlessReality?.enabled && { label: '检查 Reality 目标', onClick: () => checkRealityNow(s) },
          { label: '删除', danger: true, onClick: () => removeServer(s) },
        ]) }, '更多 ▾')))));
  }
  v.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, allCb), ['服务器', '状态', '协议 / 端口', '出口', '操作'].map((t) => h('th', {}, t)))), tb)));
}

const serverSel = new Set();
async function serverBatch(action, arg) {
  const ids = [...serverSel];
  toast(`正在处理 ${ids.length} 台服务器…`);
  try {
    const r = await api.call('servers:batch', ids, action, arg);
    if (r.fail.length) toast(`成功 ${r.ok.length} 台，失败 ${r.fail.length} 台：\n` + r.fail.join('\n'), 'warn');
    else toast(`已完成 ${r.ok.length} 台`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  dirty = false; renderBanner(); render();
}

function promptText(title, label, placeholder = '') {
  return new Promise((resolve) => {
    const inp = h('input', { placeholder });
    modal({ title, body: field(label, inp), onClose: () => resolve(null), buttons: [{ label: '取消', onClick: () => resolve(null) }, { label: '确定', class: 'primary', onClick: () => resolve(inp.value.trim() || null) }] });
    setTimeout(() => inp.focus(), 50);
  });
}

async function repickReality(s) {
  toast('正在 VPS 上寻找 Reality 目标（约 1 分钟）…');
  try {
    const r = await api.call('server:repickReality', s.id);
    toast(`Reality 目标换成 ${r.domain}（${r.source === 'neighbor' ? '同网段邻居' : '备选大站里最快的'}），已同步。用户刷新订阅即可`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
  render();
}

async function checkRealityNow(s) {
  toast('正在检查 Reality 目标…');
  try {
    const r = await api.call('server:realityCheck', s.id);
    if (r.fails === 0) toast(`Reality 目标 ${r.current} 正常`, 'ok');
    else toast(`Reality 目标 ${r.current} 检查失败（第 ${r.fails} 次）：${r.lastErr}`, 'warn');
  } catch (e) { toast(e.message, 'err'); }
}

async function editServer(orig) {
  const s = orig ? JSON.parse(JSON.stringify(orig)) : await api.call('new:server', {});
  const I = (val, attrs = {}) => h('input', { value: val ?? '', ...attrs });
  const name = I(s.name), host = I(s.host, { placeholder: 'VPS 公网 IP 或域名' }), port = I(s.sshPort, { type: 'number' }), user = I(s.username);
  const auth = h('select', {}, h('option', { value: 'password' }, '密码'), h('option', { value: 'key' }, '私钥'));
  auth.value = s.authType;
  const pwd = I(s.password, { type: 'password' });
  const key = h('textarea', { placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }, s.privateKey || '');
  const pass = I(s.passphrase, { type: 'password', placeholder: '私钥密码（可选）' });
  const pwdBox = field('SSH 密码', pwd), keyBox = h('div', {}, field('SSH 私钥', key), pass);
  const syncAuth = () => { pwdBox.classList.toggle('hidden', auth.value !== 'password'); keyBox.classList.toggle('hidden', auth.value !== 'key'); };
  auth.onchange = syncAuth; syncAuth();
  const role = h('select', {}, h('option', { value: 'node' }, '节点机'), h('option', { value: 'relay' }, '中转机（只做转发）'));
  role.value = s.role || 'node';
  // 自签证书的 SNI：常用大站 / 自定义。客户端核对的是证书指纹，名字本身对抗封锁影响不大，所以不做「优选」，
  // 只保证别选国内按 SNI 屏蔽的域名（会被直接掐断）
  const SELF_SNI = [['www.bing.com', '必应（默认）'], ['www.microsoft.com', '微软'], ['www.apple.com', '苹果'], ['www.amazon.com', '亚马逊'], ['www.nvidia.com', '英伟达'], ['www.samsung.com', '三星']];
  const curSni = s.tlsSni || 'www.bing.com';
  const sniSel = h('select', {}, SELF_SNI.map(([d, n]) => h('option', { value: d }, `${n}  ${d}`)), h('option', { value: '__custom__' }, '自定义域名…'));
  sniSel.value = SELF_SNI.some(([d]) => d === curSni) ? curSni : '__custom__';
  const sniCustom = I(sniSel.value === '__custom__' ? curSni : '', { placeholder: '例如 www.example.com' });
  const sniHint = h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '5px' } });
  const sniBox = h('div', {}, sniSel, h('div', { style: { marginTop: '6px' } }, sniCustom), sniHint);
  const drawSni = () => {
    sniCustom.classList.toggle('hidden', sniSel.value !== '__custom__');
    const v = sniSel.value === '__custom__' ? sniCustom.value.trim() : sniSel.value;
    sniHint.innerHTML = '';
    const blocked = sniBlocked(v);
    if (blocked) sniHint.append(h('span', { class: 'tag bad' }, '不能用'), ` ${v} 在国内按域名屏蔽，客户端连接会被直接掐断`);
    else sniHint.append('只是证书上的名字，客户端靠证书指纹认服务器，换哪个对抗封锁差别不大，不需要优选。想更像正常网站，用下面的「正式证书」。',
      s.deployedAt && v && v !== curSni ? h('div', { style: { color: 'var(--warn)', marginTop: '3px' } }, '改了以后同步时会重新生成证书，证书指纹会变，用户要刷新一次订阅') : null);
  };
  sniSel.onchange = drawSni; sniCustom.oninput = drawSni;
  const exit = h('select', {}, h('option', { value: '' }, '直连（VPS 自己的 IP）'), S.landings.map((l) => h('option', { value: l.id }, `落地：${l.name}`)));
  exit.value = s.exit?.type === 'landing' ? s.exit.landingId : '';

  const domain = I(s.domain, { placeholder: 'node1.example.com' });
  const acmeEmail = I(s.acmeEmail, { placeholder: 'you@example.com' });
  const acme = h('input', { type: 'checkbox', checked: !!s.acme });
  const syncAcmeSni = () => {
    sniSel.disabled = acme.checked; sniCustom.disabled = acme.checked;
    if (acme.checked) { sniHint.innerHTML = ''; sniHint.append('已开启正式证书：SNI 就是下面填的域名，这里不起作用'); } else drawSni();
  };
  acme.addEventListener('change', syncAcmeSni); syncAcmeSni();
  const host6 = I(s.host6, { placeholder: '2001:db8::1' });
  const ipMode = h('select', {}, h('option', { value: 'v4' }, '只出 IPv4 线路'), h('option', { value: 'dual' }, 'IPv4 + IPv6 线路'), h('option', { value: 'v6only' }, '只出 IPv6 线路（没填 IPv6 时自动用 IPv4）'));
  ipMode.value = s.ipMode || 'v4';
  const rt = s.routing || {};
  const blockBT = h('input', { type: 'checkbox', checked: !!rt.blockBT });
  const blockAds = h('input', { type: 'checkbox', checked: !!rt.blockAds });
  const blockCN = h('input', { type: 'checkbox', checked: !!rt.blockCN });
  const warpOn = h('input', { type: 'checkbox', checked: !!rt.warp?.enabled });
  const warpSites = Object.entries(WARP_SITE_LABELS).map(([k, l]) => ({ k, cb: h('input', { type: 'checkbox', checked: (rt.warp?.sites || ['openai', 'netflix', 'google', 'disney', 'spotify']).includes(k) }), l }));
  const warpBox = h('div', { style: { margin: '-4px 0 10px 24px' } },
    h('div', {}, warpSites.map(({ cb, l }) => h('label', { style: { marginRight: '14px', whiteSpace: 'nowrap' } }, cb, ' ', l))),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, s.warp?.privateKey ? `已注册 WARP 账号（${s.warp.address4}）` : '同步时会在 VPS 上自动注册一个免费 WARP 账号', s.warp?.privateKey ? [' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); s.warp = null; s.warpReset = true; toast('保存并同步后会重新注册'); } }, '重新注册')] : null));
  const syncWarp = () => warpBox.classList.toggle('hidden', !warpOn.checked);
  warpOn.onchange = syncWarp; syncWarp();

  const vpsExp = I(s.vpsExpireAt ? new Date(s.vpsExpireAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '', { type: 'date' });
  const cft = s.cfTunnel || {};
  const cfOn = h('input', { type: 'checkbox', checked: !!cft.enabled });
  const cfToken = I(cft.token, { type: 'password', placeholder: 'eyJhIjoi…（Cloudflare Zero Trust 里新建隧道后给的令牌）' });
  const cfHost = I(cft.hostname, { placeholder: 'cf.example.com' });
  const cfCdn = h('textarea', { placeholder: '每行一个优选域名或 IP，例如：\nwww.visa.com.sg\nicook.tw\n104.16.1.1', style: { minHeight: '70px' } }, (cft.cdnHosts || []).join('\n'));
  const cfBox = h('div', { style: { margin: '-4px 0 10px 24px' } },
    h('p', { class: 'muted', style: { fontSize: '12px', marginTop: 0 } }, '用法：Cloudflare 控制台 → Zero Trust → Networks → Tunnels → 新建隧道（选 Cloudflared），复制令牌；在隧道的 Public Hostname 里添加域名，服务填 ', h('code', {}, 'http://localhost:<VMess 端口>'), '。VPS 不用开放任何端口，IP 被墙也能用。需要勾选 VMess-WS。'),
    h('div', { class: 'row' }, field('隧道令牌', cfToken), field('隧道域名', cfHost)),
    field('优选地址（可选）', cfCdn, '每个地址会多生成一个节点，客户端连优选地址、SNI 用隧道域名，常用于提速'));
  const syncCf = () => cfBox.classList.toggle('hidden', !cfOn.checked);
  cfOn.onchange = syncCf; syncCf();

  const protoEls = {};
  const grid = h('div', { class: 'proto-grid' });
  for (const [k, label, netw] of PROTOS) {
    const pc = s.protocols[k] || {};
    const en = h('input', { type: 'checkbox', checked: pc.enabled });
    const pt = I(pc.port, { type: 'number' });
    const fixed = h('input', { type: 'checkbox', checked: !!pc.fixedPort });
    const extra = [];
    const els = { en, pt, fixed };
    if (k === 'vlessReality') {
      // Reality 目标：自动优选 / 主流大站 / 自定义。只改展示和选择方式，挑选逻辑仍在部署和巡检里
      const targets = info.realityTargets || Object.keys(REALITY_NAMES);
      const inList = targets.includes(pc.sni);
      els.rmode = h('select', {},
        h('option', { value: '__auto__' }, '自动优选（推荐）'),
        h('optgroup', { label: '固定用主流大站' }, targets.map((d) => h('option', { value: d }, REALITY_NAMES[d] ? `${REALITY_NAMES[d]}  ${d}` : d))),
        h('option', { value: '__custom__' }, '自定义域名…'));
      els.rmode.value = pc.sniAuto ? '__auto__' : inList ? pc.sni : '__custom__';
      els.rsni = I(pc.sniAuto || inList ? '' : pc.sni, { placeholder: '例如 www.example.com（要支持 TLS 1.3 和 HTTP/2）' });
      const rhint = h('div', { class: 'muted', style: { fontSize: '12px', margin: '5px 0 0' } });
      const rres = h('div', {});
      els.rcheck = pc.sniCheck || null; // 最近一次 VPS 检测（随服务器保存）
      const rtest = h('button', { class: 'small auto' }, '检测');
      const rcurrent = () => (els.rmode.value === '__auto__' ? '' : els.rmode.value === '__custom__' ? els.rsni.value.trim() : els.rmode.value);
      const srcName = { neighbor: '同网段邻居', fallback: '备选大站里 VPS 连得最快的', patrol: '巡检时自动更换' }[pc.sniSource] || '自动挑选';
      const drawR = () => {
        const m = els.rmode.value;
        els.rsni.classList.toggle('hidden', m !== '__custom__');
        rtest.classList.toggle('hidden', m === '__auto__');
        rhint.innerHTML = '';
        if (m === '__auto__') {
          if (pc.sniAuto && pc.sniPickedAt) rhint.append('当前用的是 ', h('b', {}, pc.sni), `（${srcName}，${fmtDate(pc.sniPickedAt)} 选出）`);
          else if (s.deployedAt) rhint.append('保存后会马上在这台 VPS 上挑选：先找同网段的邻居网站，找不到再从主流大站里挑连得最快的');
          else rhint.append('还没选：部署时会先找 VPS 同网段的邻居网站，找不到再从主流大站里挑 VPS 连得最快的');
        } else {
          const d = rcurrent();
          const c = els.rcheck && els.rcheck.domain === d && els.rcheck.where === 'vps' ? els.rcheck : null;
          const fresh = c && Date.now() - c.at < 24 * 3600e3;
          if (c && c.ok && fresh) rhint.append(h('span', { class: 'tag ok' }, 'VPS 检测通过'), ` ${fmtDate(c.at)}。固定使用这个目标，部署时不会自动更换`);
          else if (c && !c.ok) rhint.append(h('span', { class: 'tag bad' }, 'VPS 检测不通过'), ` ${fmtDate(c.at)}：${c.error || ''}。换一个，或改成自动优选`);
          else rhint.append(s.deployedAt ? '保存时会先在 VPS 上检测（TLS 1.3、HTTP/2、X25519、证书），不通过不能保存' : '部署时会先在 VPS 上检测（TLS 1.3、HTTP/2、X25519、证书），不通过不会部署。可以先点「检测」在本机看一下', c && !fresh ? `（上次检测已超过 24 小时：${fmtDate(c.at)}）` : '');
        }
      };
      els.rmode.onchange = () => { rres.innerHTML = ''; drawR(); };
      els.rsni.oninput = () => { rres.innerHTML = ''; drawR(); };
      rtest.onclick = (e) => busy(e.currentTarget, async () => {
        const d = rcurrent();
        if (!d) { toast('先填域名', 'err'); return; }
        const r = await api.call('tools:reality', d, s.deployedAt ? s.id : null);
        if (r.remote && r.remote.where === 'vps') els.rcheck = { ...r.remote };
        rres.innerHTML = '';
        rres.append(realityResultTable(r.local, r.remote ? { at: Date.now(), ...r.remote } : null),
          !s.deployedAt ? h('p', { class: 'muted', style: { fontSize: '12px', margin: '4px 0 0' } }, '服务器还没部署，只能在本机检测；部署时会在 VPS 上再检测一次，以 VPS 结果为准') : null);
        drawR();
      });
      drawR();
      extra.push(field('Reality 目标网站', h('div', {}, h('div', { class: 'row' }, els.rmode, rtest), h('div', { style: { marginTop: '6px' } }, els.rsni), rhint, rres)));
      extra.push(h('button', { class: 'small', onclick: async () => { const kp = await api.call('new:reality'); s.protocols.vlessReality.privateKey = kp.privateKey; s.protocols.vlessReality.publicKey = kp.publicKey; toast('已生成新密钥（保存并同步后生效）'); } }, '重新生成密钥'));
    }
    if (k === 'vmess') { els.path = I(pc.path); extra.push(field('WS 路径', els.path)); }
    if (k === 'hysteria2') {
      els.up = I(pc.upMbps || '', { type: 'number', placeholder: '不限' }); els.down = I(pc.downMbps || '', { type: 'number', placeholder: '不限' });
      els.obfs = I(pc.obfs || '', { placeholder: '留空 = 不混淆' });
      els.hop = I(pc.hopPorts || '', { placeholder: '例如 20000-30000，留空 = 不跳跃' });
      extra.push(h('div', { class: 'row' }, field('上行 Mbps', els.up), field('下行 Mbps', els.down)),
        field('salamander 混淆密码', h('div', { class: 'row' }, els.obfs, h('button', { class: 'small auto', onclick: () => { els.obfs.value = randStr(16); } }, '随机'))),
        field('端口跳跃范围（UDP）', els.hop, '客户端在这段端口里随机切换，抗封端口和 QoS'));
    }
    if (k === 'shadowsocks') extra.push(h('p', { class: 'muted', style: { fontSize: '12px', margin: 0 } }, '2022-blake3-aes-128-gcm，多用户。适合给中转、落地或老客户端用。'));
    protoEls[k] = els;
    grid.append(h('div', { class: 'proto' }, h('div', { class: 'head' }, h('label', {}, en, ' ', h('b', {}, label)), h('span', { class: 'muted' }, netw.toUpperCase())), field('端口', pt), h('label', { class: 'muted', style: { fontSize: '12px', display: 'block', margin: '-4px 0 8px' }, title: '勾上后，部署后端口不通或一键换新时都不会自动换这个端口' }, fixed, ' 固定端口（不自动更换）'), extra));
  }

  // 一键套用协议模板
  const TEMPLATES = {
    stealth: { label: '抗封锁版：Reality（自动选邻居、443）+ AnyTLS', on: ['vlessReality', 'anytls'] },
    speed: { label: '高速版：Hysteria2（混淆 + 端口跳跃）+ TUIC，Reality 备用', on: ['hysteria2', 'tuic', 'vlessReality'], hy: true },
    balanced: { label: '平衡版：Reality + Hysteria2（混淆）', on: ['vlessReality', 'hysteria2'], hyObfs: true },
  };
  const tpl = h('select', { style: { width: 'auto' } }, h('option', { value: '' }, '套用模板…'), Object.entries(TEMPLATES).map(([k, t]) => h('option', { value: k }, t.label)));
  tpl.onchange = () => {
    const t = TEMPLATES[tpl.value];
    if (!t) return;
    for (const [k] of PROTOS) protoEls[k].en.checked = t.on.includes(k);
    const r = protoEls.vlessReality;
    if (r && !r.fixed.checked) r.pt.value = 443;
    if (r) { r.rmode.value = '__auto__'; r.rmode.onchange(); }
    const hy = protoEls.hysteria2;
    if (hy && (t.hy || t.hyObfs) && !hy.obfs.value) hy.obfs.value = randStr(16);
    if (hy && t.hy && !hy.hop.value) hy.hop.value = '20000-30000';
    toast('已套用模板，检查一下端口后保存', 'ok');
    tpl.value = '';
  };

  const body = h('div', {},
    h('div', { class: 'row' }, field('名称', name), field('地址', host)),
    h('div', { class: 'row' }, field('SSH 端口', port), field('用户名', user), field('认证方式', auth)),
    pwdBox, keyBox,
    h('div', { class: 'row' }, field('角色', role), field('出口', exit), field('VPS 到期日（可选）', vpsExp, '到期前 7 天和 1 天会 Telegram 提醒续费')),
    field('自签证书域名（Trojan / Hy2 / TUIC / AnyTLS 的 SNI）', sniBox),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '14px 0 8px' } }, h('h4', { style: { margin: 0 } }, '协议'), h('div', { class: 'spacer' }), tpl), grid,
    h('h4', {}, '正式证书（可选）'),
    h('div', { class: 'row' }, field('域名', domain, '要先把这个域名的 A 记录指向服务器 IP（Cloudflare 请关掉小黄云）'), field('邮箱（可选）', acmeEmail)),
    h('label', { class: 'f' }, acme, ' 自动申请 Let\'s Encrypt 证书（Trojan / Hy2 / TUIC / AnyTLS 改用正式证书，客户端不再需要跳过证书验证；需要服务器 80 端口空闲）'),
    h('h4', {}, 'IPv6'),
    h('div', { class: 'row' }, field('IPv6 地址', host6, s.lastStatus?.ipv6 ? h('span', {}, `服务器检测到：${s.lastStatus.ipv6} `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); host6.value = s.lastStatus.ipv6; } }, '填入')) : '部署后会自动检测'), field('线路', ipMode)),
    h('h4', {}, '路由规则'),
    h('label', { class: 'f' }, blockBT, ' 屏蔽 BT 下载（防止 VPS 被版权投诉）'),
    h('label', { class: 'f' }, blockAds, ' 屏蔽广告域名'),
    h('label', { class: 'f' }, blockCN, ' 禁止访问国内网站和 IP（防止 VPS 被用来回国、IP 被标记）'),
    h('label', { class: 'f' }, warpOn, ' 指定网站走 Cloudflare WARP（解决 ChatGPT / Netflix 等拒绝机房 IP、Google 验证码）', h('span', { class: 'tag warn', style: { marginLeft: '6px', display: 'inline-block' } }, '实验性')),
    warpBox,
    h('h4', {}, 'Cloudflare 隧道'),
    h('label', { class: 'f' }, cfOn, ' 通过 Cloudflare Tunnel 接入 VMess-WS（IP 被墙或不想暴露端口时用）'),
    cfBox);

  const collect = () => {
    s.name = name.value.trim() || host.value.trim();
    s.host = host.value.trim();
    s.sshPort = Number(port.value) || 22;
    s.username = user.value.trim() || 'root';
    s.authType = auth.value; s.password = pwd.value; s.privateKey = key.value; s.passphrase = pass.value;
    s.role = role.value;
    {
      const v = (sniSel.value === '__custom__' ? sniCustom.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : sniSel.value) || 'www.bing.com';
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) throw new Error('自签证书域名格式不对：' + v);
      if (sniBlocked(v)) throw new Error(`${v} 在国内按域名屏蔽，不能做 SNI，换一个`);
      s.tlsSni = v;
    }
    s.exit = exit.value ? { type: 'landing', landingId: exit.value } : { type: 'direct' };
    s.domain = domain.value.trim(); s.acmeEmail = acmeEmail.value.trim(); s.acme = acme.checked && !!s.domain;
    if (acme.checked && !s.domain) throw new Error('开启正式证书需要先填域名');
    s.host6 = host6.value.trim().replace(/^\[|\]$/g, ''); s.ipMode = ipMode.value;
    s.routing = { blockBT: blockBT.checked, blockAds: blockAds.checked, blockCN: blockCN.checked, warp: { enabled: warpOn.checked, sites: warpSites.filter((x) => x.cb.checked).map((x) => x.k) } };
    for (const [k] of PROTOS) {
      const e = protoEls[k];
      s.protocols[k] = { ...s.protocols[k], enabled: e.en.checked, port: Number(e.pt.value), fixedPort: e.fixed.checked };
      if (e.rmode) {
        const pr = s.protocols[k];
        const m = e.rmode.value;
        if (m === '__auto__') {
          pr.sniAuto = true; // sni 保持原值作为占位，部署 / 重新优选时会被换掉
        } else {
          const nv = m === '__custom__' ? e.rsni.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : m;
          if (!nv) throw new Error('请填写 Reality 目标域名，或选「自动优选」');
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(nv)) throw new Error('Reality 目标域名格式不对：' + nv);
          if (sniBlocked(nv)) throw new Error(`${nv} 在国内按域名屏蔽，不能做 Reality 目标，换一个`);
          pr.sni = nv; pr.sniAuto = false; delete pr.sniPickedAt; delete pr.sniSource;
          if (e.rcheck && e.rcheck.domain === nv) pr.sniCheck = e.rcheck;
        }
      }
      if (e.path) s.protocols[k].path = e.path.value.trim().startsWith('/') ? e.path.value.trim() : '/' + e.path.value.trim();
      if (e.up) { s.protocols[k].upMbps = Number(e.up.value) || 0; s.protocols[k].downMbps = Number(e.down.value) || 0; }
      if (e.obfs) s.protocols[k].obfs = e.obfs.value.trim();
      if (e.hop) {
        const hv = e.hop.value.trim().replace(/\s+/g, '').replace(':', '-');
        if (hv && !/^\d+-\d+$/.test(hv)) throw new Error('端口跳跃范围格式应为 20000-30000');
        s.protocols[k].hopPorts = hv;
      }
    }
    s.vpsExpireAt = vpsExp.value ? new Date(vpsExp.value + 'T23:59:59').getTime() : 0;
    s.cfTunnel = { enabled: cfOn.checked, token: cfToken.value.trim(), hostname: cfHost.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), cdnHosts: cfCdn.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) };
    if (cfOn.checked) {
      if (!s.cfTunnel.token || !s.cfTunnel.hostname) throw new Error('开启 Cloudflare 隧道需要填令牌和域名');
      if (!s.protocols.vmess?.enabled) throw new Error('Cloudflare 隧道需要勾选 VMess-WS 协议');
    }
    if (!s.host) throw new Error('请填写地址');
    return s;
  };

  modal({ title: orig ? '编辑服务器' : '添加服务器', wide: true, body, buttons: [
    { label: '测试 SSH', close: false, onClick: async () => { const r = await api.call('server:testSsh', collect()); toast(`连接成功：${r.OS}（${r.ARCH}）${r.warn ? '\n⚠ ' + r.warn : ''}`, r.warn ? 'err' : 'ok'); } },
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => {
      const ns = collect();
      // 已部署的服务器换了固定 Reality 目标：先在 VPS 上检测，通过才保存（24 小时内通过的结果可沿用）
      const rp = ns.protocols?.vlessReality;
      const op = orig?.protocols?.vlessReality;
      if (orig?.deployedAt && rp?.enabled && !rp.sniAuto && (rp.sni !== op?.sni || op?.sniAuto || !op?.enabled)) {
        const c = rp.sniCheck;
        if (!(c && c.where === 'vps' && c.domain === rp.sni && c.ok && Date.now() - c.at < 24 * 3600e3)) {
          toast(`正在 VPS 上检测 ${rp.sni} …`);
          const r = await api.call('tools:reality', rp.sni, orig.id);
          if (!r.remote || r.remote.where !== 'vps') throw new Error('没能连上 VPS 做检测：' + (r.remote?.error || '未知错误') + '。检测通过前不能保存这个目标');
          rp.sniCheck = { ...r.remote, where: 'vps' };
          protoEls.vlessReality.rcheck = rp.sniCheck;
          protoEls.vlessReality.rmode.onchange();
          if (!r.remote.ok) {
            const bad = (r.remote.checks || []).filter((x) => !x.ok).map((x) => `${x.name}（${x.value}）`).join('、') || r.remote.error;
            throw new Error(`${rp.sni} 在 VPS 上检测不通过：${bad}。换一个目标，或改成「自动优选」`);
          }
        }
      }
      await api.call('col:upsert', 'servers', ns);
      if (orig) markDirty();
      if (orig?.deployedAt && rp?.enabled && rp.sniAuto && !orig.protocols?.vlessReality?.sniAuto) repickReality(ns); // 从固定改成自动：马上挑一次
      await render();
    } },
  ] });
}

const DEPLOY_STAGES = [['ssh', '连接 SSH'], ['agent', '上传 agent'], ['kernel', '安装内核'], ['reality', 'Reality 目标 / 端口'], ['firewall', '防火墙'], ['config', '上传配置'], ['start', '启动服务'], ['ports', '测端口'], ['done', '完成']];
function deployServer(s) {
  const pre = h('pre', { class: 'log' }, '');
  const append = (t) => { pre.textContent += t + '\n'; pre.scrollTop = pre.scrollHeight; };
  const chips = DEPLOY_STAGES.map(([id, label]) => h('span', { class: 'stage', 'data-id': id }, label));
  let cur = '';
  const setStage = (id, state) => {
    const idx = DEPLOY_STAGES.findIndex((x) => x[0] === id);
    chips.forEach((c, i) => { c.className = 'stage' + (i < idx ? ' done' : i === idx ? ' ' + (state || 'active') : ''); });
    cur = id;
  };
  const stepper = h('div', { class: 'stepper' }, chips);
  const off = api.on('task-log', (m) => {
    if (m.task !== 'deploy:' + s.id) return;
    if (m.line.startsWith('§')) { setStage(m.line.slice(1)); if (m.line === '§done') chips.forEach((c) => { c.className = 'stage done'; }); return; }
    append(m.line);
  });
  let running = false;
  const start = async () => {
    if (running) return;
    running = true; append(cur ? '重新部署（已完成的步骤会很快跳过）…' : '开始部署 …');
    try {
      const r = await api.call('server:deploy', s.id);
      append('✔ 完成');
      if (r.portChanges?.length) append('以下端口因为不通已自动更换：' + r.portChanges.join('；'));
      toast('部署成功', 'ok'); dirty = false; renderBanner(); render();
    } catch (e) {
      append('✘ ' + e.message);
      if (cur) setStage(cur, 'failed');
      const label = (DEPLOY_STAGES.find((x) => x[0] === cur) || [])[1] || '';
      append(label ? `卡在「${label}」这一步。改好后点「重试」，已经完成的步骤会很快跳过。` : '');
      const btn = m.el.querySelector('footer button.primary');
      if (btn) btn.textContent = '重试';
    } finally { running = false; }
  };
  const m = modal({ title: `部署 ${s.name}`, wide: true, body: h('div', {}, h('p', { class: 'muted' }, '会安装 sing-box（含流量统计）、NodeDeck agent、自签证书、系统服务，自动挑选 Reality 目标和端口，开启 BBR 并放行防火墙端口。已有的 NodeDeck 配置会被覆盖。'), stepper, pre), onClose: off, buttons: [
    { label: '关闭' },
    { label: '开始部署', class: 'primary', close: false, onClick: start },
  ] });
  return m;
}

const LEVEL_TAG = { ok: ['ok', '✔ 正常'], warn: ['warn', '⚠ 注意'], fail: ['bad', '✘ 异常'], skip: ['', '— 跳过'] };

function diagnoseServer(s) {
  const list = h('div', {});
  const summary = h('div', {});
  const addStep = (st) => {
    const [cls, txt] = LEVEL_TAG[st.level] || ['', st.level];
    list.append(h('div', { class: 'diag-step' }, h('span', { class: 'tag ' + cls }, txt), h('b', {}, st.title), h('div', { class: 'muted' }, st.text, st.link ? [' ', h('a', { href: st.link, target: '_blank' }, '查看详情')] : null)));
  };
  const off = api.on('task-log', (m) => { if (m.task === 'diag:' + s.id) { try { addStep(JSON.parse(m.line)); } catch (_) { /* ignore */ } } });
  const running = h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' 体检中…（本机不通的端口会从海外复核，大约要 20–40 秒；会把 IP 和端口发给 check-host.net）');
  modal({ title: `体检 ${s.name}`, wide: true, body: h('div', {}, running, list, summary), onClose: off, buttons: [{ label: '关闭' }] });
  api.call('server:diagnose', s.id).then((r) => {
    running.remove();
    const [cls, txt] = LEVEL_TAG[r.level];
    summary.append(h('div', { class: 'card', style: { marginTop: '12px' } }, h('h3', {}, '结论 ', h('span', { class: 'tag ' + cls }, txt)),
      h('ul', { style: { margin: 0, paddingLeft: '20px', lineHeight: 1.8 } }, r.advice.map((a) => h('li', {}, a))),
      r.blocked ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'primary', onclick: () => rotateServer(s) }, '一键换新')) : null));
  }).catch((e) => { running.remove(); summary.append(h('p', {}, '体检出错：' + e.message)); });
}

// 机器配置一行：1 核 · 1 GB · swap 1 GB · 磁盘剩 6.2 GB（部署 / 同步时读取）
function hwLine(s) {
  const hw = s.hw;
  if (!hw?.memMB) return null;
  const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace(/\.0$/, '') + ' GB' : mb + ' MB');
  const small = hw.memMB <= 1536;
  return h('div', { class: 'muted', style: { fontSize: '12px' }, title: small ? '小内存机器：NodeDeck 已限制内存上限。空闲约占 50MB，每个正在传数据的连接约 0.5–0.8MB' : '' },
    `${hw.cpus || '?'} 核 · ${gb(hw.memMB)}${hw.swapMB ? ` + swap ${gb(hw.swapMB)}` : ''} · 磁盘剩 ${gb(hw.diskFreeMB)}`);
}

// 国内按 SNI 屏蔽的常见域名（TLS / QUIC 握手里带这些名字会被直接重置）
const SNI_BLOCKED = ['google.com', 'googleapis.com', 'gstatic.com', 'youtube.com', 'ytimg.com', 'facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com', 'twitter.com', 'x.com', 'twimg.com', 'telegram.org', 't.me', 'wikipedia.org', 'netflix.com', 'reddit.com', 'discord.com', 'pinterest.com', 'dropbox.com', 'openai.com', 'chatgpt.com', 'blogspot.com', 'nytimes.com'];
function sniBlocked(d) {
  d = String(d || '').toLowerCase();
  return SNI_BLOCKED.some((b) => d === b || d.endsWith('.' + b));
}

function core_cf(s) { const t = s.cfTunnel; return t?.enabled && t.token && t.hostname && s.protocols?.vmess?.enabled; }
function vpsExpireTag(s) {
  if (!s.vpsExpireAt) return null;
  const d = Math.ceil((s.vpsExpireAt - Date.now()) / 86400000);
  if (d > 15) return h('div', { class: 'muted', style: { fontSize: '12px' } }, `VPS 到期 ${new Date(s.vpsExpireAt).toLocaleDateString('zh-CN')}`);
  return h('span', { class: 'tag ' + (d <= 3 ? 'bad' : 'warn') }, d < 0 ? 'VPS 已过期' : `VPS ${d} 天后到期`);
}

// ---------- 监控面板 ----------
function fmtRate(b) { return fmtBytes(b >= 1024 ? b : Math.round(b)).replace(/ (\w+)$/, ' $1/s'); }
function fmtDur(sec) { const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600); return d ? `${d} 天 ${hh} 小时` : `${hh} 小时 ${Math.floor((sec % 3600) / 60)} 分`; }
const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
function lineChart(title, series, { unit = '', fmt = (v) => v.toFixed(1) + unit, max, empty } = {}) {
  // series: [{ name, points: [[t, v]] }]
  const W = 390, H = 150, L = 62, R = 8, T = 10, B = 22;
  const all = series.flatMap((x) => x.points);
  const box = h('div', { class: 'card chart' }, h('div', { class: 'chart-head' }, h('b', {}, title), h('span', { class: 'legend' }, series.map((x, i) => h('span', {}, h('i', { style: { background: CHART_COLORS[i] } }), x.name, x.points.length ? ' ' + fmt(x.points[x.points.length - 1][1]) : '')))));
  if (Math.max(0, ...series.map((x) => x.points.length)) < 2) { box.append(h('div', { class: 'muted', style: { padding: '30px 0', textAlign: 'center' } }, empty || '数据还不够，agent 每分钟采集一次，过一会儿再看')); return box; }
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  const vmax = max || Math.max(1e-9, ...all.map((p) => p[1])) * 1.1;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - Math.min(v, vmax) / vmax) * (H - T - B);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="display:block">`;
  for (let i = 0; i <= 3; i++) {
    const v = (vmax * i) / 3, yy = y(v);
    svg += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid-line" stroke-width="1"/><text x="${L - 4}" y="${yy + 4}" font-size="10" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  const span = t1 - t0;
  const nl = span < 600 ? 1 : 4; // 时间跨度太短只标首尾，免得标签挤在一起
  for (let i = 0; i <= nl; i++) {
    const t = t0 + (span * i) / nl, d = new Date(t * 1000);
    const lab = span > 2 * 86400 ? `${d.getMonth() + 1}/${d.getDate()}` : d.toTimeString().slice(0, 5);
    svg += `<text x="${x(t)}" y="${H - 6}" font-size="10" text-anchor="${i === 0 ? 'start' : i === nl ? 'end' : 'middle'}">${lab}</text>`;
  }
  series.forEach((sr, i) => {
    if (!sr.points.length) return;
    // 时间间隔超过 3 倍正常间隔就断开（agent 停过）
    const gap = (span / Math.max(1, sr.points.length)) * 3;
    let d = '', prev = null;
    for (const [t, v] of sr.points) { d += (prev === null || t - prev > gap ? 'M' : 'L') + x(t).toFixed(1) + ',' + y(v).toFixed(1); prev = t; }
    svg += `<path d="${d}" fill="none" style="stroke:${CHART_COLORS[i]}" stroke-width="1.8" stroke-linejoin="round"/>`;
  });
  svg += '</svg>';
  box.append(h('div', { html: svg }));
  return box;
}
function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function gauge(label, pct, text) {
  const cls = pct >= 90 ? 'full' : '';
  return h('div', { class: 'card stat' }, h('div', { class: 'n', style: { fontSize: '20px' } }, text), h('div', { class: 'l' }, label), pct >= 0 ? h('div', { class: 'progress' }, h('i', { class: cls, style: { width: Math.min(100, pct) + '%' } })) : null);
}
function showMonitor(s) {
  let range = '24h';
  const body = h('div', {});
  const load = async () => {
    body.innerHTML = '';
    body.append(h('div', { class: 'muted' }, h('span', { class: 'spin' }), ' 正在读取…'));
    let m;
    try { m = await api.call('server:metrics', s.id, range); } catch (e) { body.innerHTML = ''; body.append(h('p', {}, h('span', { class: 'tag bad' }, '读取失败'), ' ', e.message, h('div', { class: 'muted' }, '监控需要 0.5.0 以上的 agent，先点「同步」升级。'))); return; }
    body.innerHTML = '';
    const n = m.now || {};
    const dpct = m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : -1;
    const expDays = s.vpsExpireAt ? Math.ceil((s.vpsExpireAt - Date.now()) / 86400000) : null;
    body.append(
      h('div', { class: 'tabs' }, [['1h', '1 小时'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']].map(([k, l]) => h('a', { class: range === k ? 'active' : '', onclick: () => { range = k; load(); } }, l))),
      h('div', { class: 'grid g4' },
        gauge(`CPU（${m.cores || '?'} 核）`, n.cpu ?? -1, n.cpu != null ? n.cpu.toFixed(1) + '%' : '—'),
        gauge('内存', n.mem ?? -1, n.mem != null ? n.mem.toFixed(1) + '%' : '—'),
        gauge('硬盘', dpct, m.diskTotal ? `${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)}` : '—'),
        gauge('本月流量（' + (m.month?.month || '') + '）', -1, `↑${fmtBytes(m.month?.tx)} ↓${fmtBytes(m.month?.rx)}`)),
      h('p', { class: 'muted', style: { margin: '8px 0' } }, `已运行 ${fmtDur(m.uptime || 0)} · 负载 ${n.load != null ? n.load.toFixed(2) : '—'} · 网速 ↑${fmtRate(n.tx || 0)} ↓${fmtRate(n.rx || 0)}`,
        expDays != null ? [' · ', h('span', { class: expDays <= 7 ? 'tag warn' : '' }, expDays < 0 ? 'VPS 已过期' : `VPS 还有 ${expDays} 天到期`)] : ' · 没填 VPS 到期日（编辑服务器里可以填）'));
    const pts = (k) => (m.series || []).map((x) => [x.t, x[k] || 0]);
    const latKeys = [...new Set((m.series || []).flatMap((x) => Object.keys(x.lat || {})))];
    body.append(h('div', { class: 'grid g2' },
      lineChart('CPU / 内存', [{ name: 'CPU', points: pts('cpu') }, { name: '内存', points: pts('mem') }], { unit: '%', max: 100, fmt: (v) => v.toFixed(0) + '%' }),
      lineChart('网速', [{ name: '上行', points: pts('tx') }, { name: '下行', points: pts('rx') }], { fmt: (v) => fmtRate(v) }),
      lineChart('三网延迟（TCP）', latKeys.map((k) => ({ name: k, points: (m.series || []).filter((x) => x.lat && x.lat[k] > 0).map((x) => [x.t, x.lat[k]]) })), { fmt: (v) => v.toFixed(0) + 'ms', empty: S.settings.latencyProbe ? '暂无数据（VPS 连不上国内测速点，或刚开始采集）' : '后台记录三网延迟没开（设置 → 巡检与告警），可以在「网络优化 → 质量」里手动测' }),
      lineChart('负载', [{ name: '1 分钟', points: pts('load') }], { fmt: (v) => v.toFixed(2) })));
  };
  modal({ title: `监控 · ${s.name}`, wide: true, body, buttons: [{ label: '刷新', close: false, onClick: load }, { label: '关闭' }] });
  load();
}

// ---------- 网络优化 ----------
const NET_TABS = [['overview', '内核设置'], ['route', '线路'], ['quality', '质量 / 晚高峰'], ['speed', '测速 / UDP'], ['compare', 'BBR 对比'], ['bench', '社区测试']];
let netTab = 'overview';
const fmtMbps = (v) => (v == null ? '—' : v >= 100 ? v.toFixed(0) + ' Mbps' : v.toFixed(1) + ' Mbps');
const fmtPct = (v, d = 1) => (v == null ? '—' : v.toFixed(d) + '%');
const fmtMs = (v) => (v == null || v < 0 ? '—' : v.toFixed(0) + ' ms');
const netAgo = (t) => (t ? fmtDate(t) : '');

function showNetLab(srv) {
  const id = srv.id;
  const body = h('div', {});
  const logBox = h('pre', { class: 'log hidden', style: { maxHeight: '140px', marginTop: '12px' } });
  const off = api.on('task-log', (m) => {
    if (m.task !== 'net:' + id) return;
    logBox.classList.remove('hidden'); logBox.textContent += m.line + '\n'; logBox.scrollTop = logBox.scrollHeight;
  });
  // 社区测试的输出轮询：每个脚本一个，用 setTimeout 串行（SSH 慢时不会重叠、重复追加输出）；重画界面时全部停掉，新界面会重新接上
  const polls = {};
  const stopPolls = () => { for (const k of Object.keys(polls)) { clearTimeout(polls[k].t); delete polls[k]; } };
  const S1 = () => S.servers.find((x) => x.id === id) || srv;
  const lab = () => S1().netLab || {};
  const run = (btn, fn) => busy(btn, async () => { await fn(); await reload(); draw(); });
  const note = (t) => h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, t);
  const tabs = h('div', { class: 'tabs' });
  const pane = h('div', {});
  body.append(tabs, pane, logBox);

  function draw() {
    stopPolls();
    tabs.innerHTML = '';
    for (const [k, l] of NET_TABS) tabs.append(h('a', { class: netTab === k ? 'active' : '', onclick: () => { netTab = k; draw(); } }, l));
    pane.innerHTML = '';
    ({ overview, route, quality, speed, compare, bench })[netTab]();
  }

  // 1. 内核设置
  function overview() {
    const ni = lab().info;
    const top = h('div', { class: 'toolbar' }, h('div', { class: 'muted' }, ni ? `检测时间 ${netAgo(ni.at)}` : '还没检测过'), h('div', { class: 'spacer' }),
      h('button', { class: ni ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:info', id)) }, ni ? '重新检测' : '检测'));
    pane.append(top);
    if (!ni) { pane.append(note('会读取内核版本、拥塞控制、发包队列、网卡、IPv4 / IPv6 和 TCP 重传情况，只读不改。')); return; }
    const kv2 = (k, v) => [h('div', { class: 'k' }, k), h('div', {}, v)];
    pane.append(h('div', { class: 'card' }, h('div', { class: 'kv' },
      kv2('系统内核', ni.kernel + (ni.container ? `（${ni.virt} 容器：大部分内核参数由宿主机决定）` : '')),
      kv2('BBR', h('span', { class: 'tag ' + (ni.cc === 'bbr' ? 'ok' : ni.bbrSupport ? 'warn' : 'bad') }, ni.bbrNote)),
      kv2('拥塞控制', `${ni.cc}（可用：${(ni.ccAvail || []).join('、')}）`),
      kv2('发包队列', `${ni.qdisc}${ni.iface?.qdisc ? `，网卡当前 ${ni.iface.qdisc}` : ''}`),
      kv2('网卡', `${ni.iface?.name || '?'} · ${ni.iface?.driver || ''} · MTU ${ni.iface?.mtu || '?'} · ${ni.iface?.txQueues || 1} 个发送队列${ni.iface?.speed ? ' · ' + ni.iface.speed : ''}`),
      kv2('IPv4 / IPv6', `${ni.ipv4 ? '有' : '无'} / ${ni.ipv6 ? '有' : '无'}`),
      kv2('TCP 重传率', `${fmtPct(ni.tcp?.retransPct, 2)}（开机以来）${ni.tcp?.retransPct > 2 ? ' — 偏高，线路可能有丢包' : ''}`),
      kv2('TCP 连接', `${ni.tcp?.established || 0} 个已建立 · ${ni.tcp?.timeWait || 0} 个等待关闭`))));
    const pending = (ni.items || []).filter((x) => x.apply);
    const cbs = {};
    const list = h('div', { class: 'card' }, h('h3', {}, pending.length ? `建议调整 ${pending.length} 项` : '设置已经合适'),
      note('只改有依据的几项。改之前会备份原值，随时可以「恢复原始设置」。勾掉的不会改。'));
    for (const it of ni.items || []) {
      const cb = it.apply ? h('input', { type: 'checkbox', checked: true }) : null;
      if (cb) cbs[it.key] = cb;
      list.append(h('div', { class: 'diag-step' },
        it.apply ? h('label', { style: { gridRow: 'span 2' } }, cb, ' 改') : h('span', { class: 'tag ok' }, '合适'),
        h('div', {}, h('b', {}, it.name), ' ', h('span', { class: 'mono muted' }, it.apply ? `${it.cur} → ${it.want}` : it.cur),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, it.why))));
    }
    list.append(h('div', { class: 'toolbar', style: { marginTop: '12px', marginBottom: 0 } },
      pending.length ? h('button', { class: 'primary', onclick: (e) => run(e.currentTarget, async () => {
        const keys = Object.entries(cbs).filter(([, c]) => c.checked).map(([k]) => k);
        if (!keys.length) { toast('没有勾选', 'warn'); return; }
        const r = await api.call('net:tune', id, keys);
        toast((r.done?.length ? '已调整：\n' + r.done.join('\n') : '没有改动') + (r.error ? '\n' + r.error : ''), r.error ? 'warn' : 'ok');
      }) }, '应用勾选的调整') : null,
      ni.backup ? h('button', { onclick: (e) => run(e.currentTarget, async () => {
        if (!(await confirmBox('把网络设置恢复成第一次调整前的样子？'))) return;
        const r = await api.call('net:restore', id);
        toast(r.error || (r.done?.length ? '已恢复：\n' + r.done.join('\n') : '已经是原始设置'), r.error ? 'warn' : 'ok');
      }) }, '恢复原始设置') : null));
    pane.append(list);
  }

  // 2. 线路
  function route() {
    const tr = lab().trace; const fw = lab().fwd;
    const lineTag = (l) => h('span', { class: 'tag ' + (/GIA|9929|CMIN2|CMI/.test(l) ? 'ok' : /未识别/.test(l) ? '' : /GT|10099/.test(l) ? 'blue' : 'warn') }, l);
    const hopsLine = (hops) => h('div', { class: 'mono muted', style: { fontSize: '11px', marginTop: '4px', wordBreak: 'break-all' } }, (hops || []).map((x) => `${x.ip}${x.ms ? ` ${x.ms.toFixed(0)}ms` : ''}`).join(' → '));
    const box1 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '回程（VPS → 国内三网）'), h('div', { class: 'spacer' }), tr ? h('span', { class: 'muted' }, netAgo(tr.at)) : null,
      h('button', { class: tr ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:trace', id)) }, tr ? '重新测' : '开始测（约 30 秒）')),
      note('从 VPS 到北京、上海、广州的电信 / 联通 / 移动做路由追踪，按经过的骨干网判断线路。回程决定下载速度，最重要。'));
    if (tr) {
      const tb = h('tbody');
      for (const r of tr.list || []) {
        const det = h('tr', { class: 'hidden' }, h('td', { colspan: 4 }, hopsLine(r.hops)));
        tb.append(h('tr', {}, h('td', {}, r.name), h('td', {}, r.error ? h('span', { class: 'tag bad' }, '失败') : lineTag(r.line)), h('td', { class: 'muted' }, r.error || r.lineTip),
          h('td', {}, r.hops?.length ? h('button', { class: 'small', onclick: () => det.classList.toggle('hidden') }, `${r.hops.length} 跳`) : '')), det);
      }
      box1.append(h('table', { style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['目标', '线路', '说明', ''].map((t) => h('th', {}, t)))), tb));
    }
    const box2 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '去程（你的电脑 → VPS）'), h('div', { class: 'spacer' }), fw ? h('span', { class: 'muted' }, netAgo(fw.at)) : null,
      h('button', { onclick: (e) => run(e.currentTarget, () => api.call('net:traceForward', id)) }, fw ? '重新测' : '开始测（约 1 分钟）')),
      note('用 Windows 自带的路由追踪。去程决定上传和延迟。开着代理软件的 TUN / 全局模式会测成代理的路线，先关掉。'));
    if (fw) box2.append(fw.error ? h('p', {}, h('span', { class: 'tag bad' }, '失败'), ' ', fw.error) : h('div', { style: { marginTop: '8px' } }, lineTag(fw.line), ' ', h('span', { class: 'muted' }, fw.lineTip), hopsLine(fw.hops)));
    pane.append(box1, box2);
  }

  // 3. 质量 / 晚高峰
  function quality() {
    const pg = lab().ping;
    const pbox = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '三网延迟 / 丢包 / 抖动'), h('div', { class: 'spacer' }), pg ? h('span', { class: 'muted' }, netAgo(pg.at)) : null,
      h('button', { class: pg ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:ping', id)) }, pg ? '重新测' : '测一次（约 5 秒）')),
      note('从 VPS 往国内电信、联通、移动各发 20 个 ping，流量很小。晚高峰（20–24 点）再测一次，可以对比平时和高峰的差别。'));
    if (pg) pbox.append(h('table', { style: { marginTop: '8px' } }, h('thead', {}, h('tr', {}, ['', '延迟', '丢包', '抖动', '最低 / 最高'].map((t) => h('th', {}, t)))),
      h('tbody', {}, Object.entries(pg.list || {}).map(([k, r]) => h('tr', {}, h('td', {}, k),
        r.recv ? [h('td', {}, fmtMs(r.avg)), h('td', { style: { color: r.loss >= 5 ? 'var(--danger)' : r.loss > 0 ? 'var(--warn)' : '' } }, fmtPct(r.loss, 0)), h('td', {}, fmtMs(r.jitter)), h('td', { class: 'muted' }, `${r.min.toFixed(0)} / ${r.max.toFixed(0)} ms`)]
          : h('td', { colspan: 4, class: 'muted' }, r.error || '全部丢包：可能是这条线路不通，也可能是对方不回应 ping'))))));
    pane.append(pbox);
    // 后台记录（设置里打开后才有）
    const out = h('div', {});
    pane.append(h('div', { class: 'card' }, h('h3', {}, '平时 vs 晚高峰（后台记录）'), out));
    if (!S.settings.latencyProbe) out.append(note('后台记录没开（默认关，省流量）。需要长期对比的话，在「设置 → 巡检与告警」里打开「后台记录三网延迟」，VPS 每 5 分钟测一次，攒一两天后这里会显示 7 天的平时和晚高峰对比。'));
    else {
      out.append(h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' 读取中…'));
      api.call('net:peak', id).then((r) => {
        out.innerHTML = '';
        const keys = Object.keys(r.report || {});
        if (!keys.length) { out.append(note('还没有数据：需要 0.7.0 以上的 agent（点「同步」升级），运行几个小时后再看。')); return; }
        const cell = (a, b, f, badAt) => { const worse = a != null && b != null && b > a * 1.3 && b > badAt; return h('td', {}, f(a), ' / ', h('span', { style: { color: worse ? 'var(--danger)' : '' } }, f(b))); };
        out.append(h('table', {}, h('thead', {}, h('tr', {}, ['', '延迟（平时 / 晚高峰）', '丢包', '抖动'].map((t) => h('th', {}, t)))),
          h('tbody', {}, keys.map((k) => { const x = r.report[k]; return h('tr', {}, h('td', {}, k), cell(x.off.lat, x.peak.lat, fmtMs, 20), cell(x.off.loss, x.peak.loss, (v) => fmtPct(v), 1), cell(x.off.jit, x.peak.jit, fmtMs, 5)); }))));
        if (r.now) out.append(note(`当前 TCP 重传率 ${fmtPct(r.now.retr, 2)} · TCP 连接 ${r.now.conn ?? '—'} 个（重传率持续高于 2% 说明线路丢包多）`));
      }).catch((e) => { out.innerHTML = ''; out.append(h('p', {}, h('span', { class: 'tag bad' }, '读取失败'), ' ', e.message)); });
    }
    const mtu = lab().mtu;
    const mbox = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '路径 MTU'), h('div', { class: 'spacer' }), mtu ? h('span', { class: 'muted' }, netAgo(mtu.at)) : null,
      h('button', { onclick: (e) => run(e.currentTarget, () => api.call('net:mtu', id)) }, mtu ? '重新测' : '开始测')),
      note('测 VPS 到三网能通过的最大包。小于 1500 说明中间有隧道之类的设备，已开启的「路径 MTU 探测」会自动处理，一般不用管。'));
    if (mtu) mbox.append(h('div', { class: 'kv', style: { marginTop: '8px' } }, h('div', { class: 'k' }, '网卡 MTU'), h('div', {}, mtu.iface?.mtu || '?'),
      (mtu.paths || []).flatMap((p) => [h('div', { class: 'k' }, `到${p.name}`), h('div', {}, p.error ? h('span', { class: 'muted' }, p.error) : `${p.mtu}${p.mtu < 1500 ? '（比 1500 小）' : ''}`)])));
    pane.append(mbox);
  }

  // 4. 测速 / UDP
  function speed() {
    const sp = lab().speed; const ud = lab().udp;
    pane.append(note('测的是你这台电脑到 VPS 这一段，也就是用户实际走的路。测之前关掉代理软件的 TUN / 全局模式。每次测速最多消耗 VPS 约 250MB 流量（速度越快用得越多）。'));
    const b1 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, 'TCP 速度'), h('div', { class: 'spacer' }), sp ? h('span', { class: 'muted' }, netAgo(sp.at)) : null,
      h('button', { class: sp ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:speed', id)) }, sp ? '重新测' : '开始测（约 20 秒）')));
    if (sp) b1.append(h('div', { class: 'statstrip', style: { gridTemplateColumns: 'repeat(3, 1fr)', marginTop: '10px', marginBottom: 0 } },
      h('div', {}, h('div', { class: 'n' }, sp.down?.error ? '—' : fmtMbps(sp.down?.mbps).replace(' Mbps', ''), h('small', {}, ' Mbps')), h('div', { class: 'l' }, sp.down?.error || '下载（VPS → 你）')),
      h('div', {}, h('div', { class: 'n' }, sp.up?.error ? '—' : fmtMbps(sp.up?.mbps).replace(' Mbps', ''), h('small', {}, ' Mbps')), h('div', { class: 'l' }, sp.up?.error || '上传（你 → VPS）')),
      h('div', {}, h('div', { class: 'n' }, sp.down?.ttfbMs ?? '—', h('small', {}, ' ms')), h('div', { class: 'l' }, '首字节时间'))));
    const b2 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, 'UDP 丢包 / 抖动（Hysteria2、TUIC 走 UDP）'), h('div', { class: 'spacer' }), ud ? h('span', { class: 'muted' }, netAgo(ud.at)) : null,
      h('button', { class: ud ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:udp', id)) }, ud ? '重新测' : '开始测（约 7 秒）')),
      note('每 20 毫秒发一个 1200 字节的包（和 QUIC 包差不多大），一共 250 个，看回来多少。'));
    if (ud) b2.append(ud.error && !ud.recv ? h('p', {}, h('span', { class: 'tag bad' }, '不通'), ' ', ud.error) : h('div', { class: 'statstrip', style: { marginTop: '10px', marginBottom: 0 } },
      h('div', {}, h('div', { class: 'n', style: { color: ud.loss >= 10 ? 'var(--danger)' : ud.loss >= 3 ? 'var(--warn)' : '' } }, ud.loss.toFixed(1), h('small', {}, ' %')), h('div', { class: 'l' }, `丢包（${ud.recv}/${ud.sent}）`)),
      h('div', {}, h('div', { class: 'n' }, ud.avg.toFixed(0), h('small', {}, ' ms')), h('div', { class: 'l' }, `延迟（最低 ${ud.min.toFixed(0)}，95% ${ud.p95.toFixed(0)}）`)),
      h('div', {}, h('div', { class: 'n' }, ud.jitter.toFixed(1), h('small', {}, ' ms')), h('div', { class: 'l' }, '抖动')),
      h('div', {}, h('div', { class: 'n' }, ud.maxBurst), h('div', { class: 'l' }, '最多连续丢包'))));
    const b3 = h('div', { class: 'card' }, h('h3', {}, 'Hysteria2 / TUIC 建议'));
    if (!ud) b3.append(note('先做一次 UDP 测试（最好也测一下 TCP 速度），这里会根据结果给建议。'));
    else api.call('net:advice', id).then((tips) => {
      for (const t of tips) b3.append(h('div', { style: { margin: '6px 0' } }, h('span', { class: 'tag ' + ({ ok: 'ok', warn: 'warn', bad: 'bad', info: 'blue' }[t.level] || '') }, { ok: '正常', warn: '注意', bad: '问题', info: '建议' }[t.level] || ''), ' ', t.text,
        t.action ? [' ', h('button', { class: 'small', onclick: (e) => run(e.currentTarget, async () => {
          if (t.action === 'antiqos' && !(await confirmBox('给 Hysteria2 开启 salamander 混淆和端口跳跃（20000-30000）？改完会同步到 VPS，用户要刷新订阅。'))) return;
          await api.call('net:fixQuic', id, t.action); toast('已修改并同步，用户刷新订阅即可', 'ok');
        }) }, t.action === 'antiqos' ? '开启混淆 + 端口跳跃' : '改成不限')] : null));
    }).catch((e) => b3.append(h('p', {}, e.message)));
    pane.append(b1, b2, b3);
  }

  // 5. BBR 对比
  function compare() {
    const c = lab().compare;
    const box = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, 'BBR 和 CUBIC 对比'), h('div', { class: 'spacer' }), c ? h('span', { class: 'muted' }, netAgo(c.at)) : null,
      h('button', { class: c ? '' : 'primary', onclick: (e) => run(e.currentTarget, async () => {
        if (!(await confirmBox('交替切换 BBR 和 CUBIC，各测 3 轮下载（每轮 8 秒），大约 1 分半钟，消耗 VPS 约 200–500MB 流量。测试期间新建的连接会用到正在测的那种算法，测完自动恢复原设置。开始？'))) return;
        await api.call('net:compare', id, 3);
      }) }, c ? '重新对比' : '开始对比')),
      note('两种算法交替测，减少网速随时间波动带来的误差。差距超过 15% 才算明显。只测 TCP（BBR 和 Hysteria2 / TUIC 无关）。'));
    if (c) {
      const row = (k, name) => h('tr', {}, h('td', {}, h('b', {}, name), c.orig === k ? h('span', { class: 'muted' }, '（原设置）') : ''), h('td', {}, fmtMbps(c.sum[k].mbps)), h('td', {}, fmtPct(c.sum[k].retr, 2)), h('td', {}, fmtMs(c.sum[k].ttfb)), h('td', { class: 'muted mono', style: { fontSize: '11px' } }, c[k].map((r) => r.error ? '失败' : r.mbps.toFixed(1)).join(' / ')));
      box.append(h('table', { style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['', '平均速度', '重传率', '首字节', '每轮速度'].map((t) => h('th', {}, t)))), h('tbody', {}, row('bbr', 'BBR'), row('cubic', 'CUBIC'))));
      const ni = lab().info;
      const msg = c.better === 'bbr' ? `BBR 明显更快（快 ${((c.sum.bbr.mbps / Math.max(0.1, c.sum.cubic.mbps) - 1) * 100).toFixed(0)}%），建议启用。` : c.better === 'cubic' ? 'CUBIC 在这条线路上反而更快，建议保持 CUBIC（如果之前开过 BBR，可以在「内核设置」里恢复原始设置）。' : '两者差距不到 15%，在误差范围内。长距离线路一般建议 BBR，晚高峰丢包多时差距会更明显，可以晚上再测一次。';
      box.append(h('p', { style: { marginBottom: 0 } }, h('b', {}, '结论：'), msg, ' ',
        c.better === 'bbr' && ni?.cc !== 'bbr' ? h('button', { class: 'small primary', onclick: (e) => run(e.currentTarget, async () => { const r = await api.call('net:tune', id, ['net.ipv4.tcp_congestion_control', 'net.core.default_qdisc']); toast(r.done?.join('\n') || '已启用', 'ok'); await api.call('net:info', id); }) }, '启用 BBR') : null));
    }
    pane.append(box);
  }

  // 6. 社区测试
  function bench() {
    const reports = S1().benchReports || [];
    const mk = (kind, title, desc, optsEl, getOpts) => {
      const pre = h('pre', { class: 'log hidden', style: { maxHeight: '260px', marginTop: '10px' } });
      const st = h('span', { class: 'muted' });
      let offset = 0;
      const start = h('button', { class: 'primary' }, '开始测试');
      const stop = h('button', { class: 'hidden' }, '停止');
      const tick = async () => {
        try {
          const r = await api.call('bench:poll', id, kind, offset);
          if (r.none) return false;
          if (r.text) { pre.classList.remove('hidden'); pre.textContent += r.text; pre.scrollTop = pre.scrollHeight; }
          offset = r.size;
          st.textContent = r.running ? '运行中…（可以关掉窗口，VPS 上会继续跑）' : r.url ? '已完成' : '已结束';
          stop.classList.toggle('hidden', !r.running); start.disabled = r.running;
          if (r.url && !reports.some((x) => x.url === r.url)) { reports.unshift({ kind, url: r.url, at: Date.now() }); await reload(); draw(); }
          return r.running;
        } catch (e) { st.textContent = e.message; return false; }
      };
      const follow = () => {
        if (polls[kind]) clearTimeout(polls[kind].t);
        const me = {}; polls[kind] = me;
        const step = async () => {
          if (polls[kind] !== me) return;
          const running = await tick();
          if (polls[kind] !== me) return;
          if (running) me.t = setTimeout(step, 3000); else delete polls[kind];
        };
        me.t = setTimeout(step, 3000);
      };
      start.onclick = (e) => busy(e.currentTarget, async () => {
        await api.call('bench:start', id, kind, getOpts());
        pre.textContent = ''; offset = 0; st.textContent = '已启动…';
        follow();
      });
      stop.onclick = (e) => busy(e.currentTarget, async () => { await api.call('bench:stop', id, kind); toast('已发送停止信号', 'ok'); });
      tick().then((running) => { if (running && pre.isConnected) follow(); });
      return h('div', { class: 'card' }, h('h3', {}, title), note(desc), optsEl, h('div', { class: 'toolbar', style: { marginTop: '10px', marginBottom: 0 } }, start, stop, st), pre);
    };
    const sel = (opts, v) => { const e = h('select', { class: 'auto' }, opts.map(([k, l]) => h('option', { value: k }, l))); e.value = v; return e; };
    const hq = sel([['f', '快速'], ['y', '标准'], ['n', '跳过']], 'f'); hq.style.width = '96px';
    const nq = sel([['l', '省流量'], ['y', '完整'], ['n', '跳过']], 'l'); nq.style.width = '96px';
    const iq = h('input', { type: 'checkbox', checked: true }); const bt = h('input', { type: 'checkbox', checked: true });
    const tsp = h('input', { type: 'checkbox' }); const tv4 = h('input', { type: 'checkbox', checked: true });
    pane.append(note('这两个是 NodeSeek 社区常用的测试脚本，直接在 VPS 上运行官方脚本，测完给一个可以分享的报告链接。脚本在临时系统里运行，测完自动清理。'),
      mk('nodequality', 'NodeQuality（综合：硬件、IP 质量、网络质量、回程）', '大约 5–15 分钟。完整网络测试会跑多地测速、用掉较多流量，小流量机器选「省流量」。', h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center' } }, h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, '硬件测试', hq), h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, '网络测试', nq), h('label', {}, iq, ' IP 质量'), h('label', {}, bt, ' 回程路由')),
        () => ({ hq: hq.value, nq: nq.value, iq: iq.checked ? 'y' : 'n', bt: bt.checked ? 'y' : 'n' })),
      mk('tcpquality', 'TcpQuality（国内各省三网回程丢包、大包重传）', '大约 3–8 分钟，从国内多个省份的节点测到这台 VPS 的丢包和延迟。', h('div', { style: { display: 'flex', gap: '18px' } }, h('label', {}, tv4, ' 只测 IPv4'), h('label', {}, tsp, ' 加测单线程速度（多用流量）')),
        () => ({ speedtest: tsp.checked, v4: tv4.checked })));
    if (reports.length) pane.append(h('div', { class: 'card' }, h('h3', {}, '历史报告'), h('table', {}, h('tbody', {}, reports.map((r) => h('tr', {}, h('td', {}, r.kind === 'nodequality' ? 'NodeQuality' : 'TcpQuality'), h('td', { class: 'muted' }, fmtDate(r.at)),
      h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.call('open:external', r.url); } }, r.url)), h('td', {}, h('button', { class: 'small', onclick: () => copy(r.url) }, '复制'))))))));
  }

  draw();
  modal({ title: `网络优化 · ${srv.name}`, wide: true, body, onClose: () => { off(); stopPolls(); }, buttons: [{ label: '关闭' }] });
}

async function rotateServer(s) {
  const ok = await confirmBox(`给「${s.name}」一键换新？\n\n会更换所有协议的端口（勾了「固定端口」的不换）、Reality 密钥和 VMess 路径，然后自动同步。\n用户的账号密码不变，但需要刷新订阅（或重新导入链接）才能继续用。\n\n如果是整个 IP 被墙，换新没有用，需要中转或换 IP。`, '换新');
  if (!ok) return;
  toast('正在换新并同步…');
  const r = await api.call('server:rotate', s.id);
  if (r.error) toast('已换新，但同步失败：' + r.error + '\n请稍后点「同步」', 'err');
  else toast('已换新' + (r.synced ? '并同步' : '（服务器还没部署，部署时生效）') + '：\n' + r.changes.join('\n'), 'ok');
  render();
}

async function showLogs(s) {
  const t = await api.call('server:logs', s.id);
  modal({ title: `${s.name} 日志`, wide: true, body: h('pre', { class: 'log' }, t || '（空）'), buttons: [{ label: '关闭' }] });
}

async function removeServer(s) {
  const choice = await new Promise((resolve) => {
    modal({ title: '删除服务器', body: h('div', {}, `确定删除「${s.name}」？`, s.deployedAt ? h('p', { class: 'muted' }, '可以先从服务器上卸载 NodeDeck（停止服务并删除文件）。') : null), onClose: () => resolve(null), buttons: [
      { label: '取消', onClick: () => resolve(null) },
      s.deployedAt ? { label: '卸载并删除', class: 'danger', onClick: () => resolve('uninstall') } : null,
      { label: '仅删除记录', class: 'danger', onClick: () => resolve('local') },
    ].filter(Boolean) });
  });
  if (!choice) return;
  if (choice === 'uninstall') { try { await api.call('server:uninstall', s.id); } catch (e) { toast('卸载失败：' + e.message, 'err'); } }
  await api.call('col:remove', 'servers', s.id);
  markDirty(); render();
}

// ---------- 节点 ----------
async function viewNodes(v) {
  await reload();
  v.append(h('h1', {}, '节点'), h('p', { class: 'sub' }, '这里显示的是默认用户的链接（自用）。给别人用请在「用户」里创建并发订阅。'));
  const groups = await api.call('nodes:list');
  if (!groups.length) { v.append(h('div', { class: 'card empty' }, '还没有服务器')); return; }
  for (const g of groups) {
    const tb = h('tbody');
    for (const e of g.entries) {
      const res = h('td', { class: 'muted' }, '—');
      tb.append(h('tr', {},
        h('td', {}, h('b', {}, PROTO_LABEL[e.protocol]), e.via ? h('span', { class: 'tag blue' }, '经 ' + serverName(e.via)) : null),
        h('td', { class: 'mono' }, `${e.host}:${e.port}`),
        res,
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'small', onclick: () => copy(e.link) }, '复制'),
          h('button', { class: 'small', onclick: () => showQr(e.label, e.link) }, '二维码'),
          h('button', { class: 'small primary', onclick: (ev) => busy(ev.currentTarget, () => testEntry(e, res)) }, '测试')))));
    }
    v.append(h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, g.server.name), h('span', { class: 'muted mono' }, g.server.host), g.server.deployedAt ? null : h('span', { class: 'tag warn' }, '未部署'), h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => copy(g.entries.map((e) => e.link).join('\n')) }, '复制全部')),
      g.entries.length ? h('table', {}, h('thead', {}, h('tr', {}, ['协议', '入口', '测试结果', '操作'].map((t) => h('th', {}, t)))), tb) : h('div', { class: 'muted' }, '没有启用的协议')));
  }
}

async function testEntry(e, cell) {
  cell.textContent = '测试中…';
  const r = await api.call('node:test', e, 'owner');
  cell.innerHTML = '';
  if (!r.ok) { cell.append(h('span', { class: 'tag bad' }, '不通'), h('div', { class: 'muted', style: { maxWidth: '360px', whiteSpace: 'pre-wrap' } }, r.error)); return; }
  cell.append(h('span', { class: 'tag ok' }, `${r.latency} ms`));
  if (r.ip) cell.append(h('div', {}, h('span', { class: 'mono' }, r.ip.query), ` ${r.ip.country || ''} ${r.ip.city || ''} · ${r.ip.isp || ''}`, ' ', h('span', { class: 'tag ' + (r.ip.hosting ? 'warn' : 'ok') }, r.ip.hosting ? '机房IP' : '住宅/非机房')));
}

async function showQr(title, text) {
  const src = await api.call('qr', text);
  modal({ title, body: h('div', { style: { textAlign: 'center' } }, h('img', { class: 'qr', src, style: { width: '260px', height: '260px' } }), h('p', { class: 'mono' }, text), h('p', { class: 'muted', style: { fontSize: '12px' } }, '手机请用较新版 v2rayNG（2.0 以上）/ NekoBox / Clash Meta / Hiddify；Hysteria2、TUIC 太旧的客户端会导入失败或被过滤')), buttons: [{ label: '复制', onClick: () => copy(text) }, { label: '关闭' }] });
}

// ---------- 用户 ----------
const userView = { q: '', page: 1, sel: new Set(), filter: 'all' };
const PAGE_SIZE = 50;

async function viewUsers(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '用户'), h('p', { class: 'sub' }, '按线路分配、限流量、限到期、定期重置，每个用户一个订阅地址')), h('div', { class: 'spacer' }),
    h('button', { onclick: (e) => busy(e.currentTarget, async () => { const r = await api.call('users:refreshUsage'); if (r.errors.length) toast('部分服务器读取失败：\n' + r.errors.join('\n'), 'warn'); else toast('流量已刷新', 'ok'); render(); }) }, '刷新流量'),
    h('button', { class: 'primary', onclick: () => editUser() }, '+ 添加用户')));

  const search = h('input', { placeholder: '搜索名称 / 备注', value: userView.q, style: { maxWidth: '260px' } });
  search.oninput = () => { userView.q = search.value; userView.page = 1; const pos = search.selectionStart; render().then(() => { const el = document.querySelector('#userSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }); };
  search.id = 'userSearch';
  const filter = h('select', { style: { maxWidth: '140px' } }, [['all', '全部'], ['ok', '正常'], ['bad', '停用/到期/用尽'], ['warn', '即将到期'], ['online', '在用']].map(([k, l]) => h('option', { value: k }, l)));
  filter.value = userView.filter;
  filter.onchange = () => { userView.filter = filter.value; userView.page = 1; render(); };

  const q = userView.q.trim().toLowerCase();
  const online = (u) => u.lastActive && Date.now() - u.lastActive < 15 * 60 * 1000;
  let list = S.users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.note || '').toLowerCase().includes(q));
  if (userView.filter === 'online') list = list.filter(online);
  else if (userView.filter !== 'all') list = list.filter((u) => userState(u)[1] === userView.filter);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (userView.page > pages) userView.page = pages;
  const shown = list.slice((userView.page - 1) * PAGE_SIZE, userView.page * PAGE_SIZE);
  for (const id of [...userView.sel]) if (!S.users.some((u) => u.id === id)) userView.sel.delete(id);

  const selCount = userView.sel.size;
  const batchBar = h('div', { class: 'toolbar', style: { marginBottom: '8px' } }, search, filter, h('div', { class: 'spacer' }),
    selCount ? h('span', { class: 'muted' }, `已选 ${selCount} 人`) : null,
    selCount ? h('button', { class: 'small', onclick: (e) => menu(e.currentTarget, [
      { label: '分配线路…', onClick: () => batchServers('addServers') },
      { label: '取消线路…', onClick: () => batchServers('removeServers') },
      { label: '续期…', onClick: batchExtend },
      { label: '设置流量上限…', onClick: batchLimit },
      { label: '启用', onClick: () => doBatch({ type: 'enable', enabled: true }) },
      { label: '停用', onClick: () => doBatch({ type: 'enable', enabled: false }) },
      { label: '删除', danger: true, onClick: async () => { if (await confirmBox(`删除选中的 ${selCount} 个用户？同步后立即失效。`)) { await doBatch({ type: 'delete' }); userView.sel.clear(); } } },
    ]) }, '批量操作 ▾') : null,
    selCount ? h('button', { class: 'small', onclick: () => { userView.sel.clear(); render(); } }, '取消选择') : null);

  const allCb = h('input', { type: 'checkbox', checked: shown.length > 0 && shown.every((u) => userView.sel.has(u.id)) });
  allCb.onchange = () => { for (const u of shown) allCb.checked ? userView.sel.add(u.id) : userView.sel.delete(u.id); render(); };
  const tb = h('tbody');
  for (const u of shown) {
    const used = userUsed(u);
    const [stText, stCls] = userState(u);
    const pct = u.limitGB > 0 ? Math.min(100, (used / (u.limitGB * GB)) * 100) : 0;
    const cb = h('input', { type: 'checkbox', checked: userView.sel.has(u.id) });
    cb.onchange = () => { cb.checked ? userView.sel.add(u.id) : userView.sel.delete(u.id); render(); };
    const exp = userExpire(u);
    tb.append(h('tr', {},
      h('td', {}, cb),
      h('td', {}, h('b', {}, u.name), u.note ? h('div', { class: 'muted' }, u.note) : null),
      h('td', {}, h('span', { class: 'tag ' + stCls }, stText)),
      h('td', {}, online(u) ? h('span', { class: 'tag ok' }, '● 在用') : h('span', { class: 'muted' }, u.lastActive ? ago(u.lastActive) : '从未使用')),
      h('td', {}, `${fmtBytes(used)} / ${u.limitGB > 0 ? u.limitGB + ' GB' : '不限'}`, u.limitGB > 0 ? h('div', { class: 'progress' }, h('i', { class: pct >= 100 ? 'full' : '', style: { width: pct + '%' } })) : null,
        u.resetPeriod && u.resetPeriod !== 'none' ? h('div', { class: 'muted', style: { fontSize: '12px' } }, '重置：' + RESET_LABEL[u.resetPeriod] + (u.resetPeriod === 'month' ? ` ${u.resetDay || 1} 号` : '')) : null),
      h('td', {}, exp ? fmtDate(exp) : u.expireAfterDays > 0 ? `首次使用后 ${u.expireAfterDays} 天` : '永久'),
      h('td', {}, u.serverIds === '*' ? h('span', { class: 'tag blue' }, '全部') : (u.serverIds || []).map((id) => h('span', { class: 'tag' }, serverName(id)))),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: () => showSub(u) }, '订阅'),
        h('button', { class: 'small', onclick: () => editUser(u) }, '编辑'),
        h('button', { class: 'small', onclick: (e) => menu(e.currentTarget, [
          { label: '重置已用流量', onClick: async () => { if (await confirmBox(`把「${u.name}」的已用流量清零？`)) { const r = await api.call('users:resetUsage', u.id); if (r.errors.length) toast(r.errors.join('\n'), 'warn'); else toast('已重置', 'ok'); markDirty(); render(); } } },
          { label: '续期 30 天', onClick: async () => { await api.call('users:batch', [u.id], { type: 'extend', days: 30 }); markDirty(); render(); toast('已续期 30 天，同步后生效', 'ok'); } },
          { label: u.enabled ? '停用' : '启用', onClick: async () => { await api.call('users:batch', [u.id], { type: 'enable', enabled: !u.enabled }); markDirty(); render(); } },
          u.id !== 'owner' && { label: '删除', danger: true, onClick: async () => { if (await confirmBox(`删除用户「${u.name}」？同步后立即失效。`)) { await api.call('col:remove', 'users', u.id); markDirty(); render(); } } },
        ]) }, '更多 ▾')))));
  }
  const pager = pages > 1 ? h('div', { class: 'toolbar', style: { justifyContent: 'center', marginTop: '10px' } },
    h('button', { class: 'small', disabled: userView.page <= 1, onclick: () => { userView.page--; render(); } }, '上一页'),
    h('span', { class: 'muted' }, `${userView.page} / ${pages}（共 ${list.length} 人）`),
    h('button', { class: 'small', disabled: userView.page >= pages, onclick: () => { userView.page++; render(); } }, '下一页')) : null;
  v.append(batchBar, h('div', { class: 'card' }, shown.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, allCb), ['用户', '状态', '在用', '流量', '到期', '线路', '操作'].map((t) => h('th', {}, t)))), tb) : h('div', { class: 'empty' }, '没有符合条件的用户'), pager));
  v.append(h('p', { class: 'muted' }, '提示：流量由每台 VPS 上的 agent 精确统计，超额、到期和周期重置都在 VPS 上自动执行（不用开着本软件）。打开软件时每 10 分钟自动刷新一次。修改用户后记得同步。'));
}

async function doBatch(op) {
  const n = await api.call('users:batch', [...userView.sel], op);
  toast(`已处理 ${n} 个用户，同步后生效`, 'ok'); markDirty(); render();
}
function batchServers(type) {
  const boxes = S.servers.map((s) => ({ s, cb: h('input', { type: 'checkbox' }) }));
  modal({ title: type === 'addServers' ? `给 ${userView.sel.size} 个用户分配线路` : `取消 ${userView.sel.size} 个用户的线路`, body: h('div', {}, boxes.map(({ s, cb }) => h('label', { style: { display: 'block', margin: '6px 0' } }, cb, ' ', s.name, h('span', { class: 'muted' }, ' ' + s.host))), type === 'addServers' ? h('p', { class: 'muted' }, '已经有这些线路的用户会自动跳过；「全部服务器」的用户不受影响。') : null), buttons: [
    { label: '取消' },
    { label: '确定', class: 'primary', onClick: () => doBatch({ type, serverIds: boxes.filter((b) => b.cb.checked).map((b) => b.s.id) }) },
  ] });
}
function batchExtend() {
  const days = h('input', { type: 'number', value: 30, min: 1 });
  modal({ title: `给 ${userView.sel.size} 个用户续期`, body: h('div', {}, field('增加天数（从到期日或今天起算，取较晚的）', days)), buttons: [{ label: '取消' }, { label: '续期', class: 'primary', onClick: () => doBatch({ type: 'extend', days: Number(days.value) || 30 }) }] });
}
function batchLimit() {
  const gb = h('input', { type: 'number', placeholder: '0 = 不限', min: 0, step: 'any' });
  modal({ title: `设置 ${userView.sel.size} 个用户的流量上限`, body: field('流量上限（GB）', gb), buttons: [{ label: '取消' }, { label: '确定', class: 'primary', onClick: () => doBatch({ type: 'limit', limitGB: Number(gb.value) || 0 }) }] });
}

async function editUser(orig) {
  const u = orig ? JSON.parse(JSON.stringify(orig)) : await api.call('new:user', {});
  const name = h('input', { value: u.name });
  const note = h('input', { value: u.note || '', placeholder: '备注（可选）' });
  const limit = h('input', { type: 'number', value: u.limitGB || '', placeholder: '0 = 不限', min: 0, step: 'any' });
  const reset = h('select', {}, Object.entries(RESET_LABEL).map(([k, l]) => h('option', { value: k }, l)));
  reset.value = u.resetPeriod || 'none';
  const resetDay = h('input', { type: 'number', min: 1, max: 28, value: u.resetDay || Math.min(28, new Date().getDate()) });
  const resetDayBox = field('每月几号重置（1–28）', resetDay);
  const syncReset = () => resetDayBox.classList.toggle('hidden', reset.value !== 'month');
  reset.onchange = syncReset; syncReset();

  const expMode = h('select', {}, h('option', { value: 'date' }, '指定到期日期'), h('option', { value: 'first' }, '首次使用后开始计时'), h('option', { value: 'never' }, '永久'));
  expMode.value = u.expireAfterDays > 0 ? 'first' : (u.expireAt ? 'date' : 'never');
  const exp = h('input', { type: 'date', value: u.expireAt ? new Date(u.expireAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '' });
  const quick = h('div', { class: 'actions' }, [['+30天', 30], ['+90天', 90], ['+365天', 365]].map(([l, d]) => h('button', { class: 'small', onclick: () => {
    const base = exp.value ? new Date(exp.value) : new Date();
    base.setDate(base.getDate() + d); exp.value = base.toISOString().slice(0, 10);
  } }, l)));
  const days = h('input', { type: 'number', min: 1, value: u.expireAfterDays || 30 });
  const dateBox = h('div', {}, field('到期日期', exp), quick);
  const firstBox = h('div', {}, field('有效天数', days, u.firstUsedAt ? `已于 ${fmtDate(u.firstUsedAt)} 首次使用` : '用户第一次连上节点时开始计时，适合卖"30 天卡"'));
  const syncExp = () => { dateBox.classList.toggle('hidden', expMode.value !== 'date'); firstBox.classList.toggle('hidden', expMode.value !== 'first'); };
  expMode.onchange = syncExp; syncExp();

  const enabled = h('input', { type: 'checkbox', checked: u.enabled });
  const all = h('input', { type: 'checkbox', checked: u.serverIds === '*' });
  const boxes = S.servers.map((s) => ({ s, cb: h('input', { type: 'checkbox', checked: u.serverIds === '*' || (u.serverIds || []).includes(s.id) }) }));
  const list = h('div', {}, boxes.map(({ s, cb }) => h('label', { style: { display: 'block', margin: '4px 0' } }, cb, ' ', s.name, h('span', { class: 'muted' }, ' ' + s.host))));
  const toggleList = () => list.classList.toggle('hidden', all.checked);
  all.onchange = toggleList; toggleList();
  modal({ title: orig ? '编辑用户' : '添加用户', body: h('div', {},
    h('div', { class: 'row' }, field('名称', name), field('备注', note)),
    h('div', { class: 'row' }, field('流量上限（GB）', limit), field('流量重置', reset)), resetDayBox,
    field('到期方式', expMode), dateBox, firstBox,
    h('label', { class: 'f', style: { marginTop: '10px' } }, enabled, ' 启用'),
    h('h4', {}, '可用线路'), h('label', {}, all, ' 全部服务器（以后新加的也包含）'), list), buttons: [
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => {
      u.name = name.value.trim() || '未命名'; u.note = note.value.trim();
      u.limitGB = Number(limit.value) || 0;
      if (reset.value !== (u.resetPeriod || 'none')) u.resetAnchor = Date.now();
      u.resetPeriod = reset.value;
      u.resetDay = Math.min(28, Math.max(1, Number(resetDay.value) || 1));
      if (expMode.value === 'date') { u.expireAt = exp.value ? new Date(exp.value + 'T23:59:59').getTime() : null; u.expireAfterDays = 0; }
      else if (expMode.value === 'first') { u.expireAfterDays = Math.max(1, Number(days.value) || 30); u.expireAt = null; }
      else { u.expireAt = null; u.expireAfterDays = 0; }
      u.enabled = enabled.checked;
      u.serverIds = all.checked ? '*' : boxes.filter((b) => b.cb.checked).map((b) => b.s.id);
      await api.call('col:upsert', 'users', u); markDirty(); render();
    } },
  ] });
}

async function showSub(u) {
  const r = await api.call('user:sub', u.id);
  const body = h('div', {});
  const row = (label, val, hint) => field(label, h('div', { class: 'row' }, h('input', { value: val, readonly: true }), h('button', { class: 'auto', onclick: () => copy(val) }, '复制')), hint);
  if (!r.url) body.append(h('p', { class: 'muted' }, '该用户还没有分配到任何服务器。'));
  else {
    body.append(h('div', { class: 'row', style: { alignItems: 'flex-start' } },
      h('img', { class: 'qr auto', src: r.qr }),
      h('div', {},
        row('订阅地址（通用，自动识别客户端）', r.url, 'v2rayN / v2rayNG / NekoBox / Shadowrocket / Hiddify 直接用；Clash 和 sing-box 客户端也会自动拿到对应格式。手机请用较新版 v2rayNG（2.0 以上）/ NekoBox / Clash Meta / Hiddify；Hysteria2、TUIC 太旧的客户端会导入失败或被过滤'),
        row('Clash Meta / Mihomo', r.clashUrl),
        row('sing-box（SFA / SFI / SFM，1.12 及以上）', r.singboxUrl),
        h('p', { class: 'muted' }, `状态：${r.status.reason} · 已用 ${fmtBytes(r.used)}${r.expireAt ? ' · 到期 ' + fmtDate(r.expireAt) : ''}。`, h('a', { href: r.pageUrl, target: '_blank' }, '打开订阅信息页'), '（用户在浏览器打开订阅地址会看到用量和一键导入按钮）'))));
    if (r.backups.length) body.append(h('h4', {}, '备用订阅地址（主地址打不开时用）'), r.backups.map((b) => row(b.server, b.url)));
    // 临时订阅链接：给试用或临时分享，到期自动失效，不影响主地址
    const tempBox = h('div', {});
    const drawTemp = () => {
      tempBox.innerHTML = '';
      const list = (S.users.find((x) => x.id === u.id)?.tempSubs || []).filter((t) => t.validUntil > Date.now());
      for (const t of list) tempBox.append(h('div', { class: 'row', style: { alignItems: 'center' } }, h('input', { value: t.url || '（同步后可用）', readonly: true }), h('span', { class: 'muted auto', style: { whiteSpace: 'nowrap' } }, '到 ' + fmtDate(t.validUntil)),
        t.url ? h('button', { class: 'auto small', onclick: () => copy(t.url) }, '复制') : null,
        h('button', { class: 'auto small danger', onclick: (e) => busy(e.currentTarget, async () => { await api.call('users:tempSubRemove', u.id, t.token); await reload(); drawTemp(); toast('已作废', 'ok'); }) }, '作废')));
      if (!list.length) tempBox.append(h('p', { class: 'muted', style: { margin: '4px 0' } }, '没有生效中的临时链接'));
    };
    const hours = h('select', { class: 'auto', style: { width: '120px' } }, [[24, '24 小时'], [72, '3 天'], [168, '7 天']].map(([v, l]) => h('option', { value: v }, l)));
    body.append(h('h4', {}, '临时订阅链接'), h('p', { class: 'muted', style: { marginTop: 0 } }, '内容和主订阅一样，到期后自动失效（返回 410），适合试用或临时分享；不想要了可以随时作废。'),
      h('div', { class: 'row' }, hours, h('button', { class: 'auto', onclick: (e) => busy(e.currentTarget, async () => {
        const t = await api.call('users:tempSub', u.id, Number(hours.value));
        await reload();
        copy(t.url); drawTemp();
        if (t.errors.length) toast('部分服务器同步失败：\n' + t.errors.join('\n'), 'warn');
      }) }, '生成并复制')), tempBox);
    drawTemp();
  }
  body.append(h('h4', {}, `节点链接（${r.links.length}）`), h('textarea', { readonly: true, style: { minHeight: '120px' } }, r.links.join('\n')));
  modal({ title: `${u.name} 的订阅`, wide: true, body, buttons: [{ label: '复制全部链接', onClick: () => copy(r.links.join('\n')) }, { label: '关闭' }] });
}

// ---------- 落地 ----------
let landingGroup = '';
const LANDING_TYPE = { socks: 'SOCKS5', http: 'HTTP', link: '节点链接' };
function landingAddr(l) { return l.type === 'link' ? `${l.proto || 'link'}://${l.host || '?'}:${l.port || '?'}` : `${l.type}://${l.host}:${l.port}`; }
function newLandingId() { return 'l' + Math.random().toString(36).slice(2, 9); }

// 改了落地后，自动同步正在用它的已部署服务器
async function syncLandingUsers(ids) {
  const servers = S.servers.filter((x) => x.deployedAt && x.exit?.type === 'landing' && ids.includes(x.exit.landingId));
  if (!servers.length) return;
  toast(`正在同步使用该落地的 ${servers.length} 台服务器…`);
  const bad = [];
  for (const x of servers) { try { await api.call('server:sync', x.id); } catch (e) { bad.push(`${x.name}: ${e.message}`); } }
  if (bad.length) toast('同步失败：\n' + bad.join('\n'), 'err'); else toast('已同步', 'ok');
}

async function viewLandings(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '落地'), h('p', { class: 'sub' }, '住宅 IP、SOCKS5 / HTTP 代理或机场节点。在服务器设置里把「出口」选成落地，该服务器所有节点就从落地 IP 出去')), h('div', { class: 'spacer' }),
    h('button', { onclick: () => importLandings('sub') }, '从订阅导入'),
    h('button', { onclick: () => importLandings('text') }, '批量添加'),
    h('button', { class: 'primary', onclick: () => editLanding() }, '+ 添加落地')));
  if (!S.landings.length) { v.append(h('div', { class: 'card empty' }, '还没有落地')); return; }
  const groups = [...new Set(S.landings.map((l) => l.group || '').filter(Boolean))];
  if (landingGroup && !groups.includes(landingGroup)) landingGroup = '';
  if (groups.length) v.append(h('div', { class: 'tabs' }, [['', '全部'], ...groups.map((g) => [g, g])].map(([g, l]) => h('a', { class: landingGroup === g ? 'active' : '', onclick: () => { landingGroup = g; render(); } }, `${l} (${g ? S.landings.filter((x) => x.group === g).length : S.landings.length})`))));
  const tb = h('tbody');
  for (const l of S.landings.filter((x) => !landingGroup || x.group === landingGroup)) {
    const res = h('td', { class: 'muted' }, '—');
    const usedBy = S.servers.filter((s) => s.exit?.type === 'landing' && s.exit.landingId === l.id);
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, l.name), l.group ? h('span', { class: 'tag' }, l.group) : null),
      h('td', {}, h('span', { class: 'tag' }, LANDING_TYPE[l.type] || l.type), h('div', { class: 'mono muted' }, landingAddr(l))),
      h('td', {}, usedBy.map((s) => h('span', { class: 'tag' }, s.name))), res,
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: (e) => busy(e.currentTarget, async () => {
          res.textContent = '测试中…';
          const r = await api.call('landing:test', l.id);
          res.innerHTML = '';
          if (!r.ok) res.append(h('span', { class: 'tag bad' }, '不通'), h('div', { class: 'muted' }, String(r.error).split('\n')[0]));
          else res.append(h('span', { class: 'tag ok' }, r.latency + ' ms'), r.ip ? h('div', {}, `${r.ip.query} ${r.ip.country || ''} ${r.ip.isp || ''} `, h('span', { class: 'tag ' + (r.ip.hosting ? 'warn' : 'ok') }, r.ip.hosting ? '机房IP' : '住宅/非机房')) : null);
        }) }, '测试'),
        h('button', { class: 'small', onclick: () => editLanding(l) }, '编辑'),
        h('button', { class: 'small danger', onclick: async () => { if (await confirmBox(`删除落地「${l.name}」？使用它的服务器会改为直连。`)) { const used = usedBy.filter((x) => x.deployedAt).length; await api.call('col:remove', 'landings', l.id); markDirty(); render(); if (used) toast('使用它的服务器已改为直连，记得同步'); } } }, '删除')))));
  }
  v.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['名称', '类型 / 地址', '使用中', '测试（从本机直连）', '操作'].map((t) => h('th', {}, t)))), tb)));
}

function editLanding(orig) {
  const l = orig ? { ...orig } : { id: newLandingId(), type: 'socks', port: 1080 };
  const paste = h('input', { placeholder: '粘贴 ip:端口:用户:密码、socks5://… 或 vless:// trojan:// 等节点链接，自动识别' });
  const name = h('input', { value: l.name || '' });
  const group = h('input', { value: l.group || '', placeholder: '例如 美国、日本（可选）', list: 'landingGroups' });
  const groupList = h('datalist', { id: 'landingGroups' }, [...new Set(S.landings.map((x) => x.group).filter(Boolean))].map((g) => h('option', { value: g })));
  const type = h('select', {}, Object.entries(LANDING_TYPE).map(([k, t]) => h('option', { value: k }, t)));
  type.value = l.type;
  const host = h('input', { value: l.host || '' }), port = h('input', { type: 'number', value: l.port || '' });
  const user = h('input', { value: l.username || '' }), pass = h('input', { value: l.password || '' });
  const link = h('textarea', { style: { minHeight: '70px' } }, l.type === 'link' ? l.link : '');
  const proxyBox = h('div', {}, h('div', { class: 'row' }, field('地址', host), field('端口', port)), h('div', { class: 'row' }, field('用户名', user), field('密码', pass)));
  const linkBox = field('节点链接（vless / vmess / trojan / ss / hysteria2 / tuic / anytls）', link);
  const sw = () => { proxyBox.classList.toggle('hidden', type.value === 'link'); linkBox.classList.toggle('hidden', type.value !== 'link'); };
  type.onchange = sw; sw();
  paste.onchange = async () => {
    const r = (await api.call('landing:parse', paste.value))[0];
    if (!r || !r.ok) { toast('无法识别：' + (r?.error || ''), 'err'); return; }
    const x = r.landing;
    type.value = x.type; sw();
    if (x.type === 'link') link.value = x.link; else { host.value = x.host; port.value = x.port; user.value = x.username || ''; pass.value = x.password || ''; }
    if (!name.value) name.value = r.name;
  };
  modal({ title: orig ? '编辑落地' : '添加落地', body: h('div', {}, field('快速识别（粘贴后按回车或点别处）', paste), h('div', { class: 'row' }, field('名称', name), field('分组', group), field('类型', type)), groupList, proxyBox, linkBox), buttons: [
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => {
      Object.assign(l, { name: name.value.trim(), group: group.value.trim(), type: type.value });
      if (l.type === 'link') {
        const r = (await api.call('landing:parse', link.value.trim()))[0];
        if (!r || !r.ok || r.landing.type !== 'link') throw new Error('节点链接无法识别：' + (r?.error || ''));
        Object.assign(l, r.landing, { name: l.name || r.name });
        delete l.username; delete l.password;
      } else {
        Object.assign(l, { host: host.value.trim(), port: Number(port.value), username: user.value, password: pass.value });
        delete l.link; delete l.proto;
        if (!l.host || !l.port) throw new Error('请填写地址和端口');
        if (!l.name) l.name = l.host;
      }
      await api.call('col:upsert', 'landings', l);
      render();
      if (orig) await syncLandingUsers([l.id]);
    } },
  ] });
}

// 批量添加 / 从订阅导入：先识别，再勾选要加的
function importLandings(mode) {
  const input = mode === 'sub' ? h('input', { placeholder: '机场订阅地址（通用 / v2rayN 格式）' }) : h('textarea', { style: { minHeight: '140px' }, placeholder: '每行一个：\nip:端口:用户:密码\nsocks5://用户:密码@ip:端口#名称\nvless://… trojan://… hysteria2://… 等节点链接' });
  const group = h('input', { placeholder: '分组（可选），例如 美国' });
  const result = h('div', {});
  let parsed = [];
  const showResult = () => {
    result.innerHTML = '';
    const ok = parsed.filter((x) => x.ok);
    const bad = parsed.filter((x) => !x.ok);
    const filter = h('input', { placeholder: '按名称筛选，例如 美国 / US', style: { marginBottom: '6px' } });
    const rows = ok.map((x) => ({ x, cb: h('input', { type: 'checkbox', checked: true }) }));
    const list = h('div', { style: { maxHeight: '260px', overflow: 'auto' } });
    const draw = () => {
      list.innerHTML = '';
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) if (!q || r.x.name.toLowerCase().includes(q)) list.append(h('label', { style: { display: 'block', margin: '3px 0' } }, r.cb, ' ', r.x.name, h('span', { class: 'muted mono' }, `  ${LANDING_TYPE[r.x.landing.type]} ${r.x.landing.host}:${r.x.landing.port}`)));
    };
    filter.oninput = () => { const q = filter.value.trim().toLowerCase(); for (const r of rows) r.cb.checked = !q || r.x.name.toLowerCase().includes(q); draw(); };
    draw();
    result.append(...[h('p', {}, `识别到 ${ok.length} 个`, bad.length ? h('span', { class: 'muted' }, `，${bad.length} 行无法识别`) : null), ok.length > 8 ? filter : null, list].filter(Boolean));
    result.rows = rows;
  };
  modal({ title: mode === 'sub' ? '从订阅导入落地' : '批量添加落地', wide: true, body: h('div', {}, input, h('div', { class: 'row', style: { marginTop: '8px' } }, group, h('button', { class: 'auto', onclick: (e) => busy(e.currentTarget, async () => {
    parsed = mode === 'sub' ? await api.call('landing:fetchSub', input.value) : await api.call('landing:parse', input.value);
    showResult();
  }) }, '识别')), result), buttons: [
    { label: '取消' },
    { label: '添加选中的', class: 'primary', onClick: async () => {
      const chosen = (result.rows || []).filter((r) => r.cb.checked);
      if (!chosen.length) throw new Error('先点「识别」并勾选要添加的');
      for (const r of chosen) await api.call('col:upsert', 'landings', { id: newLandingId(), name: r.x.name, group: group.value.trim(), ...r.x.landing });
      toast(`已添加 ${chosen.length} 个落地`, 'ok'); render();
    } },
  ] });
}

// ---------- 中转 / 隧道 ----------
async function viewForwards(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '中转 / 隧道'), h('p', { class: 'sub' }, '在中转 VPS 上开端口转发。目标选节点协议时，相关用户的订阅会自动多一条经中转的线路（节点 IP 被墙也能用）')), h('div', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: () => editForward() }, '+ 添加转发')));
  if (!S.forwards.length) { v.append(h('div', { class: 'card empty' }, '还没有转发规则')); return; }
  const tb = h('tbody');
  for (const f of S.forwards) {
    const relay = S.servers.find((s) => s.id === f.relayServerId);
    const target = f.target?.type === 'node' ? `${serverName(f.target.serverId)} / ${PROTO_LABEL[f.target.protocol]}` : `${f.target?.host}:${f.target?.port}${f.target?.network ? ' (' + f.target.network + ')' : ''}`;
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, f.name || '—')),
      h('td', { class: 'mono' }, `${relay?.name || '?'} : ${f.listenPort}`),
      h('td', {}, '→ ', target),
      h('td', {}, f.enabled === false ? h('span', { class: 'tag' }, '停用') : h('span', { class: 'tag ok' }, '启用')),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small', onclick: () => editForward(f) }, '编辑'),
        h('button', { class: 'small danger', onclick: async () => { if (await confirmBox('删除这条转发？')) { await api.call('col:remove', 'forwards', f.id); markDirty(); render(); } } }, '删除')))));
  }
  v.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['名称', '入口（中转机:端口）', '目标', '状态', '操作'].map((t) => h('th', {}, t)))), tb)));
}

function editForward(orig) {
  if (!S.servers.length) { toast('请先添加服务器', 'err'); return; }
  const f = orig ? JSON.parse(JSON.stringify(orig)) : { id: 'f' + Math.random().toString(36).slice(2, 9), listenPort: 30000 + Math.floor(Math.random() * 20000), target: { type: 'node' }, enabled: true };
  const name = h('input', { value: f.name || '', placeholder: '例如：香港中转→美国' });
  const relay = h('select', {}, S.servers.map((s) => h('option', { value: s.id }, `${s.name} (${s.host})`)));
  relay.value = f.relayServerId || (S.servers.find((s) => s.role === 'relay') || S.servers[0]).id;
  const lp = h('input', { type: 'number', value: f.listenPort });
  const ttype = h('select', {}, h('option', { value: 'node' }, '节点协议'), h('option', { value: 'custom' }, '自定义地址（隧道）'));
  ttype.value = f.target.type;
  const tsrv = h('select', {}, S.servers.map((s) => h('option', { value: s.id }, s.name)));
  if (f.target.serverId) tsrv.value = f.target.serverId;
  const tproto = h('select', {});
  const fillProto = () => {
    const s = S.servers.find((x) => x.id === tsrv.value);
    tproto.innerHTML = '';
    for (const [k, l] of PROTOS) if (s?.protocols?.[k]?.enabled) tproto.append(h('option', { value: k }, `${l} (${s.protocols[k].port})`));
    if (f.target.protocol) tproto.value = f.target.protocol;
  };
  tsrv.onchange = fillProto; fillProto();
  const thost = h('input', { value: f.target.host || '' }), tport = h('input', { type: 'number', value: f.target.port || '' });
  const tnet = h('select', {}, h('option', { value: '' }, 'TCP+UDP'), h('option', { value: 'tcp' }, 'TCP'), h('option', { value: 'udp' }, 'UDP'));
  tnet.value = f.target.network || '';
  const en = h('input', { type: 'checkbox', checked: f.enabled !== false });
  const nodeBox = h('div', { class: 'row' }, field('目标服务器', tsrv), field('协议', tproto));
  const customBox = h('div', { class: 'row' }, field('目标地址', thost), field('目标端口', tport), field('网络', tnet));
  const sw = () => { nodeBox.classList.toggle('hidden', ttype.value !== 'node'); customBox.classList.toggle('hidden', ttype.value !== 'custom'); };
  ttype.onchange = sw; sw();
  modal({ title: orig ? '编辑转发' : '添加转发', body: h('div', {}, field('名称', name), h('div', { class: 'row' }, field('中转服务器', relay), field('监听端口', lp)), field('目标类型', ttype), nodeBox, customBox, h('label', {}, en, ' 启用')), buttons: [
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => {
      f.name = name.value.trim(); f.relayServerId = relay.value; f.listenPort = Number(lp.value); f.enabled = en.checked;
      f.target = ttype.value === 'node' ? { type: 'node', serverId: tsrv.value, protocol: tproto.value } : { type: 'custom', host: thost.value.trim(), port: Number(tport.value), network: tnet.value };
      if (f.target.type === 'node' && !f.target.protocol) throw new Error('目标服务器没有启用协议');
      if (f.target.type === 'node' && f.target.serverId === f.relayServerId) throw new Error('中转机和目标不能是同一台');
      if (f.target.type === 'custom' && (!f.target.host || !f.target.port)) throw new Error('请填写目标地址和端口');
      await api.call('col:upsert', 'forwards', f); markDirty(); render();
    } },
  ] });
}

// ---------- 工具箱 ----------
let toolTab = 'ip';
async function viewTools(v) {
  await reload();
  v.append(h('h1', {}, '工具箱'), h('p', { class: 'sub' }, '无需登录即可使用'));
  const tabs = [['ip', 'IP 画像'], ['ports', '端口检测'], ['dns', 'DNS 查询'], ['trace', '路由追踪'], ['block', '被墙检测'], ['reality', 'Reality 域名检测'], ['socks', 'SOCKS5 转二维码']];
  const box = h('div', { class: 'card' });
  const tabBar = h('div', { class: 'tabs' }, tabs.map(([id, l]) => h('a', { class: toolTab === id ? 'active' : '', onclick: () => { toolTab = id; render(); } }, l)));
  v.append(tabBar, box);
  TOOLS[toolTab](box);
}

const TOOLS = {
  ip(box) {
    const ip = h('input', { placeholder: '留空 = 查询本机出口 IP' });
    const out = h('div', {});
    const btn = h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
      out.innerHTML = '';
      const r = await api.call('tools:ip', ip.value);
      out.append(h('div', { class: 'kv', style: { marginTop: '14px' } }, kv('IP', r.query), kv('类型', h('span', { class: 'tag ' + (r.hosting || r.proxy ? 'warn' : 'ok') }, r.kind)), kv('位置', `${r.country} ${r.regionName} ${r.city}`), kv('运营商', r.isp), kv('组织', r.org), kv('ASN', r.as), kv('时区', r.timezone)));
    }) }, '查询');
    box.append(h('div', { class: 'row' }, ip, btn), out);
  },
  ports(box) {
    const host = h('input', { placeholder: 'IP 或域名' }), ports = h('input', { placeholder: '443,8443,2000-2010' });
    const out = h('div', {});
    box.append(h('div', { class: 'row' }, host, ports, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
      const r = await api.call('tools:ports', host.value, ports.value);
      out.innerHTML = '';
      out.append(h('p', { class: 'muted' }, '从本机发起 TCP 连接。国内测不通而 VPS 本身正常，通常说明端口或 IP 被墙。UDP 协议（Hy2/TUIC）无法这样检测，请用节点测试。'),
        h('div', {}, r.map((x) => h('span', { class: 'tag ' + (x.ok ? 'ok' : 'bad') }, `${x.port} ${x.ok ? x.ms + 'ms' : x.error}`))));
    }) }, '检测')), out);
  },
  block(box) {
    const host = h('input', { placeholder: 'IP 或域名' }), port = h('input', { placeholder: '端口，例如 443', style: { maxWidth: '140px' } });
    const out = h('div', {});
    box.append(h('p', { class: 'muted' }, '同时从本机（国内）和海外多个节点（check-host.net）测 TCP 端口：海外通、本机不通 = 很可能被墙。会把 IP 和端口发给 check-host.net，大约需要 20 秒。'),
      h('div', { class: 'row' }, host, port, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
        out.innerHTML = '';
        const r = await api.call('tools:block', host.value, port.value || 443);
        out.append(h('div', { class: 'kv', style: { marginTop: '14px' } },
          kv('结论', h('span', { class: 'tag ' + (r.verdict.level === 'ok' ? 'ok' : r.verdict.level === 'warn' ? 'warn' : 'bad') }, r.verdict.text)),
          kv('本机', r.local.ok ? `通 · ${r.local.ms} ms` : `不通（${r.local.error}）`),
          kv('海外', r.overseas ? h('div', {}, r.overseas.nodes.map((n) => h('span', { class: 'tag ' + (n.ok ? 'ok' : 'bad') }, `${n.country || n.node} ${n.city || ''} ${n.ok ? n.ms + 'ms' : '✘'}`))) : h('span', { class: 'muted' }, '检测失败：' + r.overseasError)),
          kv('复核', h('a', { href: r.pingpe, target: '_blank' }, '在 ping.pe 多地测试'))));
      }) }, '检测')), out);
  },
  dns(box) {
    const name = h('input', { placeholder: '域名' });
    const type = h('select', { class: 'auto', style: { width: '100px' } }, ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map((t) => h('option', {}, t)));
    const server = h('select', { class: 'auto', style: { width: '170px' } }, [['', '系统默认'], ['223.5.5.5', '阿里 223.5.5.5'], ['119.29.29.29', '腾讯 119.29.29.29'], ['1.1.1.1', 'Cloudflare 1.1.1.1'], ['8.8.8.8', 'Google 8.8.8.8']].map(([v, l]) => h('option', { value: v }, l)));
    const out = h('pre', { class: 'log', style: { marginTop: '12px' } }, '');
    box.append(h('div', { class: 'row' }, name, type, server, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
      try { const r = await api.call('tools:dns', name.value, type.value, server.value); out.textContent = `耗时 ${r.ms} ms\n` + JSON.stringify(r.records, null, 2); } catch (err) { out.textContent = '查询失败：' + err.message; }
    }) }, '查询')), out);
  },
  trace(box) {
    const host = h('input', { placeholder: 'IP 或域名' });
    const out = h('pre', { class: 'log', style: { marginTop: '12px', minHeight: '200px' } }, '');
    const off = api.on('task-log', (m) => { if (m.task === 'trace') { out.textContent += m.line + '\n'; out.scrollTop = out.scrollHeight; } });
    box.append(h('div', { class: 'row' }, host, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => { out.textContent = ''; await api.call('tools:trace', host.value); }) }, '开始追踪')), out);
    const obs = new MutationObserver(() => { if (!document.body.contains(box)) { off(); obs.disconnect(); } });
    obs.observe(document.getElementById('view'), { childList: true });
  },
  reality(box) {
    const d = h('input', { placeholder: '例如 www.microsoft.com' });
    const srv = h('select', { class: 'auto', style: { width: '220px' } }, h('option', { value: '' }, '仅本机检测'), S.servers.filter((s) => s.deployedAt).map((s) => h('option', { value: s.id }, `同时从 ${s.name} 检测`)));
    if (S.servers.some((s) => s.deployedAt)) srv.value = S.servers.find((s) => s.deployedAt).id; // 默认带上 VPS，结果以 VPS 为准
    const out = h('div', {});
    box.append(h('p', { class: 'muted' }, 'Reality 目标要求：TLS 1.3、HTTP/2、X25519，且离 VPS 越近越好（从服务器检测的延迟越低越好）。'),
      h('div', { class: 'row' }, d, srv, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
        const r = await api.call('tools:reality', d.value, srv.value);
        out.innerHTML = '';
        const remote = r.remote ? { at: Date.now(), ...r.remote } : null;
        out.append(h('div', { style: { marginTop: '12px' } }, realityResultTable(r.local, remote)),
          h('p', { class: 'muted', style: { fontSize: '12px' } }, remote ? 'Reality 是 VPS 去连目标网站，能不能用以 VPS 的结果为准；本机结果只说明你这边能否访问。鼠标停在结果上能看到具体数值。' : '没选服务器，只做了本机检测。选一台已部署的服务器可以同时在 VPS 上检测，以 VPS 结果为准。'));
      }) }, '检测')), out);
    // 从服务器扫描附近的 Reality 目标
    const scanSrv = h('select', { class: 'auto', style: { width: '220px' } }, S.servers.filter((x) => x.deployedAt).map((x) => h('option', { value: x.id }, x.name)));
    const scanOut = h('div', {});
    box.append(h('h4', { style: { marginTop: '22px' } }, '从服务器扫描附近目标'),
      h('p', { class: 'muted' }, '在 VPS 上扫描同网段的 IP，找出支持 TLS 1.3 + HTTP/2 的网站。同机房的网站延迟最低，最适合做 Reality 目标。需要 1~2 分钟。'),
      S.servers.some((x) => x.deployedAt) ? h('div', { class: 'row' }, scanSrv, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
        scanOut.innerHTML = '';
        const list = await api.call('tools:realityScan', scanSrv.value);
        if (!list.length) { scanOut.append(h('p', { class: 'muted' }, '附近没找到合适的网站，可以用上面手动检测 www.microsoft.com、www.apple.com 这类大站。')); return; }
        const srv = S.servers.find((x) => x.id === scanSrv.value);
        scanOut.append(h('table', { style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['域名', 'IP', '延迟', '证书签发', '到期', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, list.map((r) => h('tr', {}, h('td', { class: 'mono' }, r.domain), h('td', { class: 'mono muted' }, r.ip), h('td', {}, r.ms + ' ms'), h('td', { class: 'muted' }, r.issuer), h('td', { class: 'muted' }, r.notAfter),
            h('td', {}, h('button', { class: 'small', onclick: async () => {
              const cur = S.servers.find((x) => x.id === srv.id);
              // 选了扫描结果就是固定目标；同步时会在 VPS 上按完整标准再检测一次
              cur.protocols.vlessReality = { ...cur.protocols.vlessReality, sni: r.domain, sniAuto: false, sniPickedAt: undefined, sniSource: undefined };
              await api.call('col:upsert', 'servers', cur); markDirty();
              toast(`${srv.name} 的 Reality 目标改成 ${r.domain}，同步后生效`, 'ok');
            } }, '用这个')))))));
      }) }, '开始扫描')) : h('p', { class: 'muted' }, '先部署一台服务器'), scanOut);
  },
  socks(box) {
    const ta = h('textarea', { placeholder: '每行一个，支持：\nip:端口:用户:密码\n用户:密码@ip:端口\nsocks5://用户:密码@ip:端口#名称' });
    const out = h('div', { class: 'grid g3', style: { marginTop: '12px' } });
    box.append(ta, h('div', { class: 'toolbar', style: { marginTop: '8px' } }, h('button', { class: 'primary', onclick: (e) => busy(e.currentTarget, async () => {
      const r = await api.call('tools:socks', ta.value);
      out.innerHTML = '';
      for (const x of r) {
        if (!x.ok) { out.append(h('div', { class: 'card' }, h('span', { class: 'tag bad' }, '无法识别'), h('div', { class: 'mono' }, x.input))); continue; }
        out.append(h('div', { class: 'card', style: { textAlign: 'center' } }, h('img', { class: 'qr', src: x.qr }), h('div', {}, h('b', {}, x.name)), h('div', { class: 'mono muted' }, x.plain),
          h('div', { class: 'actions', style: { justifyContent: 'center', marginTop: '6px' } }, h('button', { class: 'small', onclick: () => copy(x.link) }, '复制 socks://'), h('button', { class: 'small', onclick: () => copy(x.plain) }, '复制 socks5://'))));
      }
    }) }, '生成')), out);
  },
};
function kv(k, v) { return [h('div', { class: 'k' }, k), h('div', {}, v)]; }

// ---------- 设置 ----------
function updateCard() {
  const st = updateStatus;
  const card = h('div', { class: 'card' }, h('h3', {}, '软件更新'));
  const text = {
    idle: '尚未检查', checking: '正在检查…', latest: `已是最新版本（${st.latest || info.version}）`, available: `发现新版本 ${st.latest}`,
    downloading: `正在下载新版本 ${st.latest || ''}`, downloaded: `新版本 ${st.latest} 已下载，重启时自动安装（不弹安装窗口）`, error: '检查失败：' + (st.error || ''), dev: '开发模式不检查更新',
  }[st.state || 'idle'];
  card.append(h('p', {}, `当前版本 v${info.version}${info.portable ? '（便携版）' : ''}`), h('p', { class: st.state === 'error' ? 'muted' : '' }, text));
  if (st.state === 'downloading') card.append(updProgress(st));
  const acts = h('div', { class: 'actions' }, h('button', { onclick: (e) => busy(e.currentTarget, () => api.call('update:check')) }, '检查更新'));
  if (st.state === 'available') acts.append(h('button', { class: 'primary', onclick: () => api.call('update:download') }, info.portable ? '下载新版便携包' : '立即更新'));
  if (st.state === 'downloaded') acts.append(h('button', { class: 'primary', onclick: () => api.call('update:install') }, '重启并安装'));
  card.append(acts, h('p', { class: 'muted', style: { marginTop: '10px' } }, '启动 10 秒后自动检查，之后每 30 分钟检查一次。更新从 GitHub 下载，国内需要先开代理。'));
  return card;
}

async function viewSettings(v) {
  await reload();
  const st = S.settings;
  const subPort = h('input', { type: 'number', value: st.subPort });
  const statsPort = h('input', { type: 'number', value: st.statsPort });
  const adminPort = h('input', { type: 'number', value: st.adminPort });
  const sbBase = h('input', { value: st.singboxBase });
  const sbAuto = h('input', { type: 'checkbox', checked: st.singboxAutoUpdate !== false });
  const autoUp = h('input', { type: 'checkbox', checked: st.autoUpdate !== false });
  const mode = st.sshProxy && st.sshProxy !== 'auto' && st.sshProxy !== 'off' ? 'custom' : (st.sshProxy || 'auto');
  const proxyMode = h('select', {}, h('option', { value: 'auto' }, '自动（直连不通时找本机 V2rayN / Clash 代理）'), h('option', { value: 'custom' }, '指定代理地址'), h('option', { value: 'off' }, '关闭（只直连）'));
  proxyMode.value = mode;
  const proxyUrl = h('input', { value: mode === 'custom' ? st.sshProxy : '', placeholder: 'socks5://127.0.0.1:10808 或 http://127.0.0.1:10809' });
  const proxyRow = field('代理地址', proxyUrl);
  const syncProxy = () => proxyRow.classList.toggle('hidden', proxyMode.value !== 'custom');
  proxyMode.onchange = syncProxy; syncProxy();
  const detected = h('span', { class: 'muted' });
  const subDomain = h('input', { value: st.subDomain || '', placeholder: '留空 = 用用户的主服务器 IP；可填 sub.example.com 或 https://sub.example.com' });
  const tz = h('select', {}, [['Asia/Shanghai', '北京时间（UTC+8）'], ['Asia/Hong_Kong', '香港'], ['Asia/Taipei', '台北'], ['Asia/Tokyo', '东京（UTC+9）'], ['Asia/Singapore', '新加坡'], ['Europe/London', '伦敦'], ['America/Los_Angeles', '洛杉矶'], ['America/New_York', '纽约'], ['UTC', 'UTC']].map(([k, l]) => h('option', { value: k }, l)));
  tz.value = st.timezone || 'Asia/Shanghai';
  const uw = st.upgradeWindow || {};
  const uwOn = h('input', { type: 'checkbox', checked: !!uw.enabled });
  const uwStart = h('input', { type: 'number', min: 0, max: 23, value: uw.start ?? 3 });
  const uwEnd = h('input', { type: 'number', min: 0, max: 23, value: uw.end ?? 5 });
  const tg = st.telegram || {};
  const tgOn = h('input', { type: 'checkbox', checked: !!tg.enabled });
  const tgToken = h('input', { value: tg.botToken || '', placeholder: '123456:ABC-DEF…（找 @BotFather 创建机器人获得）' });
  const tgChat = h('input', { value: tg.chatId || '', placeholder: '你的 Telegram 用户 ID（找 @userinfobot 获得）' });
  const tgDaily = h('input', { type: 'checkbox', checked: tg.daily !== false });
  const tgHour = h('input', { type: 'number', min: 0, max: 23, value: tg.dailyHour ?? 9 });
  const tgDays = h('input', { type: 'number', min: 0, value: tg.warnDays ?? 3 });
  const tgPct = h('input', { type: 'number', min: 0, max: 100, value: tg.warnPercent ?? 90 });
  const tgServer = h('select', { style: { width: 'auto', maxWidth: '200px' } }, S.servers.filter((x) => x.deployedAt).map((x) => h('option', { value: x.id }, x.name)));
  const saveTg = async () => {
    await api.call('settings:set', { telegram: { enabled: tgOn.checked, botToken: tgToken.value.trim(), chatId: tgChat.value.trim(), daily: tgDaily.checked, dailyHour: Number(tgHour.value) || 0, warnDays: Number(tgDays.value) || 0, warnPercent: Number(tgPct.value) || 0 } });
  };
  const sel = (opts, val) => { const e = h('select', {}, opts.map(([k, l]) => h('option', { value: k }, l))); e.value = val; return e; };
  const rpMode = sel([['auto', '自动换新目标并通知'], ['notify', '只通知'], ['off', '不检查']], st.realityPatrol || 'auto');
  const bwMode = sel([['off', '关闭（需要时在「工具箱 → 被墙检测」或服务器「体检」里手动查）'], ['notify', '只提醒'], ['auto', '自动一键换新（6 小时内最多一次）并提醒']], st.blockWatch || 'off');
  const al = st.alerts || {};
  const alOn = h('input', { type: 'checkbox', checked: al.enabled !== false });
  const tuneOn = h('input', { type: 'checkbox', checked: st.smallBoxTuning !== false });
  const netOn = h('input', { type: 'checkbox', checked: st.netAutoTune !== false });
  const probeOn = h('input', { type: 'checkbox', checked: !!st.latencyProbe });
  const alDisk = h('input', { type: 'number', min: 50, max: 99, value: al.diskPct || 90 });
  const alCpu = h('input', { type: 'number', min: 50, max: 100, value: al.cpuPct || 90 });
  const alLat = h('input', { type: 'number', min: 50, value: al.latencyMs || 300 });
  const theme = sel([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']], st.theme || 'system');
  theme.onchange = async () => { await api.call('settings:set', { theme: theme.value }); S.settings.theme = theme.value; applyTheme(); };
  const lookCard = h('div', { class: 'card' }, h('h3', {}, '外观'), field('主题', theme, '深色适合长时间看监控；跟随系统会随 Windows 的深浅色自动切换'));
  const guardCard = h('div', { class: 'card' }, h('h3', {}, '巡检与告警'),
    field('Reality 目标巡检（VPS 每 6 小时检查一次）', rpMode, '目标网站下线、证书过期或不再支持 TLS 1.3 / HTTP2 时节点会连不上。自动模式下连续 3 次失败会换成同网段邻居或最快的大站，并改好本机订阅'),
    field('被墙巡检（打开后软件开着时每 30 分钟查一次，默认关）', bwMode, '本机连不通、海外能通，连续两次才判定被墙；电脑网络断了不会误报'),
    h('label', { class: 'f' }, alOn, ' Telegram 运维告警：sing-box 挂了（会先自动重启）、磁盘快满、CPU 持续过高、三网延迟变差'),
    h('div', { class: 'row' }, field('磁盘用到 %', alDisk), field('CPU 连续 15 分钟高于 %', alCpu), field('三网延迟高于 ms', alLat)),
    h('label', { class: 'f' }, probeOn, ' 后台记录三网延迟和丢包：VPS 每 5 分钟往国内三网各发 10 个 ping（每台每月几十 MB 流量）。打开后监控面板的延迟曲线、「网络优化」的晚高峰对比和延迟告警才有数据。默认关，平时在「网络优化 → 质量」里手动测'),
    h('label', { class: 'f' }, netOn, ' 部署时自动做其它网络优化：检测后只改有依据的几项（缓冲区、路径 MTU 探测）。BBR + fq 部署时总会开启。原值都会备份，在服务器「更多 → 网络优化」里可以随时恢复'),
    h('label', { class: 'f' }, tuneOn, ' 小配置 VPS 自动优化：内存 ≤ 2GB 且没有 swap 时加一个 swap 文件（1GB 内存加 1GB，2GB 内存加 2GB，磁盘不够会减小或跳过），磁盘 < 20GB 时把系统日志限制在 200MB。卸载时会一并撤销'),
    h('button', { class: 'primary', onclick: async () => {
      await api.call('settings:set', { latencyProbe: probeOn.checked, netAutoTune: netOn.checked, smallBoxTuning: tuneOn.checked, realityPatrol: rpMode.value, blockWatch: bwMode.value, alerts: { enabled: alOn.checked, diskPct: Number(alDisk.value) || 90, cpuPct: Number(alCpu.value) || 90, latencyMs: Number(alLat.value) || 300 } });
      toast('已保存，点「同步全部」后各服务器生效', 'ok'); markDirty();
    } }, '保存'));
  v.append(h('h1', {}, '设置'), h('p', { class: 'sub' }, `数据目录：${info.dataDir}`));
  v.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('h3', {}, '服务器端'),
      field('订阅端口（对外开放）', subPort),
      h('div', { class: 'row' }, field('统计 API 端口（仅本机）', statsPort), field('agent 管理端口（仅本机）', adminPort)),
      field('订阅域名（可选）', subDomain, '把一个域名解析到任意一台已部署的服务器，订阅地址就不会因为换服务器而改变'),
      field('时区', tz, '流量重置、日报、升级时间段都按这个时区计算'),
      field('sing-box 内核渠道', sbBase, '默认是你仓库里名为 singbox 的 Release，GitHub Actions 每天自动构建官方最新正式版'),
      h('label', { class: 'f' }, sbAuto, ' VPS 自动升级 sing-box 内核（每 6 小时检查，升级前校验配置，失败自动回滚）'),
      h('label', { class: 'f' }, uwOn, ' 只在指定时间段升级（避免白天断线）'),
      h('div', { class: 'row' }, field('从几点', uwStart), field('到几点', uwEnd)),
      h('label', { class: 'f' }, autoUp, ' 自动检查软件更新'),
      h('button', { class: 'primary', onclick: async () => {
        await api.call('settings:set', { subPort: Number(subPort.value) || 2096, statsPort: Number(statsPort.value) || 9092, adminPort: Number(adminPort.value) || 9091, singboxBase: sbBase.value.trim(), singboxAutoUpdate: sbAuto.checked, autoUpdate: autoUp.checked,
          subDomain: subDomain.value.trim(), timezone: tz.value, upgradeWindow: { enabled: uwOn.checked, start: Number(uwStart.value) || 0, end: Number(uwEnd.value) || 0 } });
        toast('已保存，点「同步全部」后对各 VPS 生效（改了端口需要重新部署）', 'ok'); markDirty();
      } }, '保存')),
    h('div', {}, updateCard(), lookCard, guardCard,
      h('div', { class: 'card' }, h('h3', {}, 'Telegram 通知'),
        h('p', { class: 'muted' }, '由各台 VPS 上的 agent 直接发送，电脑关机也能收到：用户快到期 / 流量快用完 / 被停用、内核升级结果、每日流量报告。'),
        h('label', { class: 'f' }, tgOn, ' 开启'),
        field('机器人 Token', tgToken), field('接收消息的 Chat ID', tgChat),
        h('label', { class: 'f' }, tgDaily, ' 每日报告'),
        h('div', { class: 'row' }, field('日报时间（几点）', tgHour), field('提前几天提醒到期', tgDays), field('用到百分之几提醒', tgPct)),
        h('div', { class: 'actions' },
          h('button', { class: 'primary', onclick: async () => { await saveTg(); toast('已保存，点「同步全部」后各服务器生效', 'ok'); markDirty(); } }, '保存'),
          tgServer.options.length ? tgServer : null,
          tgServer.options.length ? h('button', { onclick: (e) => busy(e.currentTarget, async () => { await saveTg(); await api.call('server:sync', tgServer.value); await api.call('telegram:test', tgServer.value); toast('测试消息已发送，去 Telegram 看看', 'ok'); }) }, '从这台服务器发测试消息') : h('span', { class: 'muted' }, '部署服务器后可以发测试消息'))),
      h('div', { class: 'card' }, h('h3', {}, 'SSH 连接'),
        field('经本机代理连接 VPS', proxyMode, '国内直连 VPS 的 SSH 常被干扰；自动模式下直连失败会改走代理（密码错误不会重试）'), proxyRow,
        h('div', { class: 'actions' },
          h('button', { onclick: async () => {
            const val = proxyMode.value === 'custom' ? proxyUrl.value.trim() : proxyMode.value;
            if (proxyMode.value === 'custom' && !/^(socks5?h?|http):\/\/.+:\d+$/i.test(val)) { toast('代理地址格式应为 socks5://127.0.0.1:10808', 'err'); return; }
            await api.call('settings:set', { sshProxy: val }); toast('已保存', 'ok');
          } }, '保存'),
          h('button', { onclick: (e) => busy(e.currentTarget, async () => { const l = await api.call('tools:localProxies'); detected.textContent = l.length ? '检测到：' + l.join('、') : '没有检测到本机代理'; }) }, '检测本机代理'), detected)),
      h('div', { class: 'card' }, h('h3', {}, '备份'), h('p', { class: 'muted' }, '备份文件包含服务器密码等敏感信息，请妥善保存。本地数据已用 Windows DPAPI 加密。'),
        h('div', { class: 'actions' },
          h('button', { onclick: async () => { const p = await api.call('data:export'); if (p) toast('已导出到 ' + p, 'ok'); } }, '导出备份'),
          h('button', { onclick: async () => { if (await confirmBox('导入会覆盖当前全部数据，继续？')) { if (await api.call('data:import')) { toast('导入成功', 'ok'); render(); } } } }, '导入备份'))),
      h('div', { class: 'card' }, h('h3', {}, '关于'), h('p', { class: 'muted' }, `NodeDeck · ${info.repo ? 'github.com/' + info.repo : '未配置发布仓库'} · 内置 sing-box ${info.singbox ? '✔' : '✘（节点测试不可用）'}`), h('p', { class: 'muted' }, 'sing-box 以 GPL-3.0 许可证发布，作为独立程序随附。')))));
}

const VIEWS = { dash: viewDash, servers: viewServers, nodes: viewNodes, users: viewUsers, landings: viewLandings, forwards: viewForwards, tools: viewTools, settings: viewSettings };

(async function init() {
  info = await api.call('app:info');
  updateStatus = await api.call('update:status');
  api.on('update-status', (st) => {
    const prev = updateStatus.state;
    updateStatus = st; renderFoot();
    if (prev !== st.state) renderBanner();
    else if (st.state === 'downloading') for (const el of document.querySelectorAll('.upd-progress')) el.replaceWith(updProgress(st)); // 进度原地刷新
    if (prev !== st.state && (page === 'settings' || page === 'dash')) render();
  });
  await reload();
  applyTheme();
  renderNav();
  renderBanner();
  render();
  showWhatsNew();
  api.on('toast', (p) => toast(p.text, p.level || 'warn'));
  api.on('usage-updated', () => { if (page === 'users' || page === 'dash') { if (!document.querySelector('.modal-bg')) render(); } });
})();

// 更新后第一次打开：显示这次更新了什么（读取随软件打包的 CHANGELOG.md）
function verCmp(a, b) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
async function showWhatsNew() {
  const last = S.settings.lastSeenVersion;
  if (last === info.version) return;
  await api.call('settings:set', { lastSeenVersion: info.version });
  if (!last || !info.packaged) return;
  const md = await api.call('app:changelog');
  const parts = md.split(/^## /m).slice(1).map((sec) => ({ ver: (sec.match(/^(\d+\.\d+\.\d+)/) || [])[1], text: sec })).filter((x) => x.ver && verCmp(x.ver, last) > 0 && verCmp(x.ver, info.version) <= 0);
  if (!parts.length) return;
  modal({ title: `已更新到 ${info.version}`, wide: true, body: h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, parts.map((p) => plainNotes('## ' + p.text)).join('\n\n')), buttons: [{ label: '知道了', class: 'primary' }] });
}
