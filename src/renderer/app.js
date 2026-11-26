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
  ['vlessXhttpReality', 'VLESS-XHTTP-Reality', 'tcp'],
  ['vlessXhttpTls', 'VLESS-XHTTP-TLS', 'tcp'],
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
  stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8.5a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 14.5 6 8.5"/><path d="M10.3 19.5a2 2 0 0 0 3.4 0"/></svg>',
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
  ['stock', NAV_ICONS.stock, '补货提醒'],
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
  if (st === 'available') f.append(h('div', { class: 'upd', onclick: () => goSettings('app') }, `● 新版本 ${updateStatus.latest}`));
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
        h('div', {}, label, protos.length ? h('div', { class: 'proto-chips', title: protos.join('、') }, PROTOS.filter(([k]) => s.protocols?.[k]?.enabled).map(([k]) => h('span', { class: 'pchip' }, { vlessReality: 'Reality', trojan: 'Trojan', vmess: 'VMess', hysteria2: 'Hy2', tuic: 'TUIC', anytls: 'AnyTLS', shadowsocks: 'SS', vlessXhttpReality: 'XHTTP-Reality', vlessXhttpTls: 'XHTTP-TLS' }[k] || k))) : h('span', { class: 'cap' }, '没有开启协议')),
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
