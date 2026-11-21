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

const PAGES = [
  ['dash', '▦', '概览'],
  ['servers', '⛁', '服务器'],
  ['nodes', '⌬', '节点'],
  ['users', '☺', '用户'],
  ['landings', '⌂', '落地'],
  ['forwards', '⇄', '中转 / 隧道'],
  ['tools', '⚒', '工具箱'],
  ['settings', '⚙', '设置'],
];

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
    nav.append(h('a', { class: page === id ? 'active' : '', onclick: () => go(id) }, h('span', { class: 'ico' }, ico), label));
  }
  renderFoot();
}

function renderFoot() {
  const f = document.getElementById('sideFoot');
  f.innerHTML = '';
  f.append(h('div', {}, `v${info.version || ''}${info.portable ? ' 便携版' : ''}`));
  const st = updateStatus.state;
  if (st === 'available') f.append(h('div', { class: 'upd', onclick: () => go('settings') }, `● 新版本 ${updateStatus.latest}`));
  if (st === 'downloading') f.append(h('div', { class: 'upd' }, `下载更新 ${updateStatus.percent || 0}%`));
  if (st === 'downloaded') f.append(h('div', { class: 'upd', onclick: () => api.call('update:install') }, '● 更新已就绪，点此重启'));
}

let updSnoozed = false;
function plainNotes(t) { return String(t || '').replace(/<li[^>]*>/gi, '• ').replace(/<\/(li|p|h\d|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim(); }

function renderBanner() {
  const b = document.getElementById('banner');
  b.innerHTML = '';
  const u = updateStatus;
  if ((u.state === 'available' || u.state === 'downloaded') && u.latest && u.latest !== S.settings.skipVersion && !updSnoozed) {
    b.classList.remove('hidden');
    const notes = plainNotes(u.notes);
    b.append(h('div', { style: { flex: 1 } }, h('b', {}, u.state === 'downloaded' ? `新版本 ${u.latest} 已下载好` : `发现新版本 ${u.latest}`), notes ? h('div', { class: 'notes' }, notes) : null),
      u.state === 'downloaded'
        ? h('button', { class: 'small primary', onclick: () => api.call('update:install') }, '重启并更新')
        : h('button', { class: 'small primary', onclick: () => { api.call('update:download'); updSnoozed = true; renderBanner(); } }, info.portable ? '下载新版' : '立即更新'),
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
  const v = document.getElementById('view');
  v.innerHTML = '';
  try { await VIEWS[page](v); } catch (e) { v.append(h('div', { class: 'card' }, '出错了：' + e.message)); }
}

// ---------- 概览 ----------
async function viewDash(v) {
  await reload();
  const deployed = S.servers.filter((s) => s.deployedAt);
  const nodes = (await api.call('nodes:list')).reduce((a, g) => a + g.entries.length, 0);
  const activeUsers = S.users.filter((u) => userState(u)[1] !== 'bad').length;
  const traffic = S.users.reduce((a, u) => a + userUsed(u), 0);
  v.append(h('h1', {}, '概览'), h('p', { class: 'sub' }, '填 VPS → 一键部署全套协议 → 分配给用户 → 用内置工具验证节点'));
  v.append(h('div', { class: 'grid g4' },
    stat(`${deployed.length} / ${S.servers.length}`, '已部署 / 服务器'),
    stat(nodes, '节点入口'),
    stat(`${activeUsers} / ${S.users.length}`, '可用用户'),
    stat(fmtBytes(traffic), '累计流量')));
  const steps = h('div', { class: 'card' }, h('h3', {}, '快速开始'),
    h('ol', { style: { lineHeight: '2', margin: 0, paddingLeft: '20px' } },
      h('li', {}, '「服务器」里添加 VPS（IP + root 密码），点「部署」'),
      h('li', {}, '「节点」里复制链接或扫码，点「测试」看延迟和出口 IP'),
      h('li', {}, '「用户」里创建用户、设置流量和到期时间，把订阅链接发给对方'),
      h('li', {}, '需要住宅 IP 出口：在「落地」添加 SOCKS5，再在服务器设置里选择出口'),
      h('li', {}, '节点被墙：在「中转 / 隧道」用另一台 VPS 转发，订阅里会自动多出中转线路')));
  v.append(h('div', { class: 'grid g2', style: { marginTop: '14px' } }, steps, updateCard()));
}
function stat(n, l) { return h('div', { class: 'card stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)); }

// ---------- 服务器 ----------
function agentOutdated(s) {
  const v = s.lastStatus?.agentVersion;
  return !!(s.deployedAt && v && info.packaged && v !== info.version);
}

async function viewServers(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '服务器'), h('p', { class: 'sub' }, '通过 SSH 安装 sing-box 和 agent，一键部署 6 种协议')), h('div', { class: 'spacer' }),
    h('button', { onclick: (e) => busy(e.currentTarget, syncAll) }, '同步全部'),
    h('button', { class: 'primary', onclick: () => editServer() }, '+ 添加服务器')));
  if (!S.servers.length) { v.append(h('div', { class: 'card empty' }, '还没有服务器，点右上角添加')); return; }
  const tb = h('tbody');
  for (const s of S.servers) {
    const st = s.lastStatus;
    const status = !s.deployedAt ? h('span', { class: 'tag' }, '未部署') : st && st.singbox && st.agent ? h('span', { class: 'tag ok' }, '运行中') : h('span', { class: 'tag bad' }, '异常');
    const protos = PROTOS.filter(([k]) => s.protocols?.[k]?.enabled).map(([k, l]) => h('span', { class: 'tag' }, `${l}:${s.protocols[k].port}`));
    const exit = s.exit?.type === 'landing' ? h('span', { class: 'tag blue' }, '落地: ' + (S.landings.find((l) => l.id === s.exit.landingId)?.name || '?')) : h('span', { class: 'tag' }, '直连');
    const fw = S.forwards.filter((f) => f.relayServerId === s.id).length;
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, s.name), h('div', { class: 'muted mono', style: { wordBreak: 'normal', whiteSpace: 'nowrap' } }, s.host), s.role === 'relay' ? h('span', { class: 'tag blue' }, '中转机') : null),
      h('td', {}, status, agentOutdated(s) ? h('span', { class: 'tag warn', title: '点「同步」自动升级' }, 'agent 待升级') : null, st?.version ? h('div', { class: 'muted' }, 'sing-box ' + st.version) : null, st?.mem ? h('div', { class: 'muted' }, `内存 ${st.mem} · 负载 ${st.load}`) : null),
      h('td', {}, protos.length ? protos : h('span', { class: 'muted' }, '无'), fw ? h('span', { class: 'tag blue' }, `转发 ${fw}`) : null),
      h('td', {}, exit),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: () => deployServer(s) }, s.deployedAt ? '重新部署' : '部署'),
        s.deployedAt ? h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, async () => { await api.call('server:sync', s.id); toast('已同步', 'ok'); dirty = false; renderBanner(); render(); }) }, '同步') : null,
        h('button', { class: 'small', title: '一步步检查 SSH、服务、端口、是否被墙、节点真连', onclick: () => diagnoseServer(s) }, '体检'),
        h('button', { class: 'small', onclick: () => editServer(s) }, '编辑'),
        h('button', { class: 'small', onclick: (e) => menu(e.currentTarget, [
          s.deployedAt && { label: '刷新状态', onClick: async () => { await api.call('server:status', s.id); toast('已刷新', 'ok'); render(); } },
          s.deployedAt && { label: '查看日志', onClick: () => showLogs(s) },
          s.deployedAt && { label: '升级 sing-box 内核', onClick: async () => { toast('正在检查内核更新…'); const m = await api.call('server:updateSingbox', s.id); toast(m, 'ok'); render(); } },
          { label: '一键换新（被墙时用）', onClick: () => rotateServer(s) },
          { label: '删除', danger: true, onClick: () => removeServer(s) },
        ]) }, '更多 ▾')))));
  }
  v.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['服务器', '状态', '协议 / 端口', '出口', '操作'].map((t) => h('th', {}, t)))), tb)));
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
  const sni = I(s.tlsSni, { placeholder: 'www.bing.com' });
  const exit = h('select', {}, h('option', { value: '' }, '直连（VPS 自己的 IP）'), S.landings.map((l) => h('option', { value: l.id }, `落地：${l.name}`)));
  exit.value = s.exit?.type === 'landing' ? s.exit.landingId : '';

  const domain = I(s.domain, { placeholder: 'node1.example.com' });
  const acmeEmail = I(s.acmeEmail, { placeholder: 'you@example.com' });
  const acme = h('input', { type: 'checkbox', checked: !!s.acme });
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
      els.rsni = I(pc.sni, { placeholder: 'www.microsoft.com' });
      extra.push(field('Reality 目标域名（可在工具箱检测）', els.rsni));
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

  const body = h('div', {},
    h('div', { class: 'row' }, field('名称', name), field('地址', host)),
    h('div', { class: 'row' }, field('SSH 端口', port), field('用户名', user), field('认证方式', auth)),
    pwdBox, keyBox,
    h('div', { class: 'row' }, field('角色', role), field('出口', exit)),
    field('自签证书域名（Trojan/Hy2/TUIC/AnyTLS 的 SNI）', sni),
    h('h4', {}, '协议'), grid,
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
    warpBox);

  const collect = () => {
    s.name = name.value.trim() || host.value.trim();
    s.host = host.value.trim();
    s.sshPort = Number(port.value) || 22;
    s.username = user.value.trim() || 'root';
    s.authType = auth.value; s.password = pwd.value; s.privateKey = key.value; s.passphrase = pass.value;
    s.role = role.value; s.tlsSni = sni.value.trim() || 'www.bing.com';
    s.exit = exit.value ? { type: 'landing', landingId: exit.value } : { type: 'direct' };
    s.domain = domain.value.trim(); s.acmeEmail = acmeEmail.value.trim(); s.acme = acme.checked && !!s.domain;
    if (acme.checked && !s.domain) throw new Error('开启正式证书需要先填域名');
    s.host6 = host6.value.trim().replace(/^\[|\]$/g, ''); s.ipMode = ipMode.value;
    s.routing = { blockBT: blockBT.checked, blockAds: blockAds.checked, blockCN: blockCN.checked, warp: { enabled: warpOn.checked, sites: warpSites.filter((x) => x.cb.checked).map((x) => x.k) } };
    for (const [k] of PROTOS) {
      const e = protoEls[k];
      s.protocols[k] = { ...s.protocols[k], enabled: e.en.checked, port: Number(e.pt.value), fixedPort: e.fixed.checked };
      if (e.rsni) s.protocols[k].sni = e.rsni.value.trim() || 'www.microsoft.com';
      if (e.path) s.protocols[k].path = e.path.value.trim().startsWith('/') ? e.path.value.trim() : '/' + e.path.value.trim();
      if (e.up) { s.protocols[k].upMbps = Number(e.up.value) || 0; s.protocols[k].downMbps = Number(e.down.value) || 0; }
      if (e.obfs) s.protocols[k].obfs = e.obfs.value.trim();
      if (e.hop) {
        const hv = e.hop.value.trim().replace(/\s+/g, '').replace(':', '-');
        if (hv && !/^\d+-\d+$/.test(hv)) throw new Error('端口跳跃范围格式应为 20000-30000');
        s.protocols[k].hopPorts = hv;
      }
    }
    if (!s.host) throw new Error('请填写地址');
    return s;
  };

  modal({ title: orig ? '编辑服务器' : '添加服务器', wide: true, body, buttons: [
    { label: '测试 SSH', close: false, onClick: async () => { const r = await api.call('server:testSsh', collect()); toast(`连接成功：${r.OS}（${r.ARCH}）${r.warn ? '\n⚠ ' + r.warn : ''}`, r.warn ? 'err' : 'ok'); } },
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => { await api.call('col:upsert', 'servers', collect()); if (orig) markDirty(); await render(); } },
  ] });
}

function deployServer(s) {
  const pre = h('pre', { class: 'log' }, '');
  const append = (t) => { pre.textContent += t + '\n'; pre.scrollTop = pre.scrollHeight; };
  const off = api.on('task-log', (m) => { if (m.task === 'deploy:' + s.id) append(m.line); });
  let running = false;
  const m = modal({ title: `部署 ${s.name}`, wide: true, body: h('div', {}, h('p', { class: 'muted' }, '会安装 sing-box（含流量统计）、NodeDeck agent、自签证书、systemd 服务，开启 BBR 并放行防火墙端口。已有的 NodeDeck 配置会被覆盖。'), pre), onClose: off, buttons: [
    { label: '关闭' },
    { label: '开始部署', class: 'primary', close: false, onClick: async () => {
      if (running) return;
      running = true; append('开始部署 …');
      try {
        const r = await api.call('server:deploy', s.id);
        append('✔ 完成');
        if (r.portChanges?.length) append('以下端口因为不通已自动更换：' + r.portChanges.join('；'));
        toast('部署成功', 'ok'); dirty = false; renderBanner(); render();
      } catch (e) { append('✘ ' + e.message); } finally { running = false; }
    } },
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
  modal({ title, body: h('div', { style: { textAlign: 'center' } }, h('img', { class: 'qr', src, style: { width: '260px', height: '260px' } }), h('p', { class: 'mono' }, text)), buttons: [{ label: '复制', onClick: () => copy(text) }, { label: '关闭' }] });
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
        row('订阅地址（通用，自动识别客户端）', r.url, 'v2rayN / v2rayNG / NekoBox / Shadowrocket / Hiddify 直接用；Clash 和 sing-box 客户端也会自动拿到对应格式'),
        row('Clash Meta / Mihomo', r.clashUrl),
        row('sing-box（SFA / SFI / SFM，1.12 及以上）', r.singboxUrl),
        h('p', { class: 'muted' }, `状态：${r.status.reason} · 已用 ${fmtBytes(r.used)}${r.expireAt ? ' · 到期 ' + fmtDate(r.expireAt) : ''}。`, h('a', { href: r.pageUrl, target: '_blank' }, '打开订阅信息页'), '（用户在浏览器打开订阅地址会看到用量和一键导入按钮）'))));
    if (r.backups.length) body.append(h('h4', {}, '备用订阅地址（主地址打不开时用）'), r.backups.map((b) => row(b.server, b.url)));
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
    const srv = h('select', { class: 'auto', style: { width: '220px' } }, h('option', { value: '' }, '仅本机检测'), S.servers.map((s) => h('option', { value: s.id }, `同时从 ${s.name} 检测`)));
    const out = h('div', {});
    box.append(h('p', { class: 'muted' }, 'Reality 目标要求：TLS 1.3、HTTP/2、X25519，且离 VPS 越近越好（从服务器检测的延迟越低越好）。'),
      h('div', { class: 'row' }, d, srv, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
        const r = await api.call('tools:reality', d.value, srv.value);
        out.innerHTML = '';
        const l = r.local;
        if (!l.ok && !l.checks) out.append(h('p', {}, h('span', { class: 'tag bad' }, '失败'), ' ', l.error));
        else out.append(h('div', { class: 'kv', style: { marginTop: '12px' } }, kv('结论', h('span', { class: 'tag ' + (l.ok ? 'ok' : 'bad') }, l.ok ? '适合做 Reality 目标' : '不适合')), kv('本机握手', l.ms + ' ms'), l.checks.map((c) => kv(c.name, h('span', { class: 'tag ' + (c.ok ? 'ok' : 'bad') }, (c.ok ? '✔ ' : '✘ ') + c.value))), kv('证书', `${l.subject} 到期 ${l.validTo}`)));
        if (r.remote) out.append(h('div', { class: 'kv', style: { marginTop: '10px' } }, kv('服务器端', r.remote.ok ? `TCP ${r.remote.connectMs} ms · TLS 完成 ${r.remote.tlsMs} ms · HTTP/${r.remote.http}` : h('span', { class: 'tag bad' }, r.remote.error))));
      }) }, '检测')), out);
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
    downloading: `正在下载 ${st.percent || 0}%`, downloaded: `新版本 ${st.latest} 已下载`, error: '检查失败：' + (st.error || ''), dev: '开发模式不检查更新',
  }[st.state || 'idle'];
  card.append(h('p', {}, `当前版本 v${info.version}${info.portable ? '（便携版）' : ''}`), h('p', { class: st.state === 'error' ? 'muted' : '' }, text));
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
    h('div', {}, updateCard(),
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
    if (prev !== st.state && (page === 'settings' || page === 'dash')) render();
  });
  await reload();
  renderNav();
  renderBanner();
  render();
  showWhatsNew();
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
