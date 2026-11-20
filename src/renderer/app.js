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
];
const PROTO_LABEL = Object.fromEntries(PROTOS.map(([k, l]) => [k, l]));
const GB = 1024 ** 3;

let S = null; // 全量状态
let info = {};
let updateStatus = {};
let dirty = false;
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
function userState(u) {
  if (!u.enabled) return ['已停用', 'bad'];
  if (u.expireAt && Date.now() >= u.expireAt) return ['已到期', 'bad'];
  if (u.limitGB > 0 && userUsed(u) >= u.limitGB * GB) return ['流量用尽', 'bad'];
  if (u.expireAt && u.expireAt - Date.now() < 3 * 86400000) return ['即将到期', 'warn'];
  return ['正常', 'ok'];
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

function renderBanner() {
  const b = document.getElementById('banner');
  b.innerHTML = '';
  if (!dirty || !S.servers.some((s) => s.deployedAt)) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  b.append(h('span', {}, '配置已修改，需要同步到服务器才会生效。'),
    h('button', { class: 'small primary', onclick: (e) => busy(e.currentTarget, syncAll) }, '同步全部服务器'),
    h('button', { class: 'small', onclick: () => { dirty = false; renderBanner(); } }, '稍后'));
}

async function syncAll() {
  const r = await api.call('server:syncAll');
  const bad = r.filter((x) => !x.ok);
  if (bad.length) toast('部分服务器同步失败：\n' + bad.map((x) => `${x.name}: ${x.error}`).join('\n'), 'err');
  else toast(`已同步 ${r.length} 台服务器`, 'ok');
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
      h('td', {}, status, st?.version ? h('div', { class: 'muted' }, 'sing-box ' + st.version) : null, st?.mem ? h('div', { class: 'muted' }, `内存 ${st.mem} · 负载 ${st.load}`) : null),
      h('td', {}, protos.length ? protos : h('span', { class: 'muted' }, '无'), fw ? h('span', { class: 'tag blue' }, `转发 ${fw}`) : null),
      h('td', {}, exit),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: () => deployServer(s) }, s.deployedAt ? '重新部署' : '部署'),
        s.deployedAt ? h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, async () => { await api.call('server:sync', s.id); toast('已同步', 'ok'); dirty = false; renderBanner(); render(); }) }, '同步') : null,
        s.deployedAt ? h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, async () => { await api.call('server:status', s.id); render(); }) }, '状态') : null,
        s.deployedAt ? h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, () => showLogs(s)) }, '日志') : null,
        h('button', { class: 'small', onclick: () => editServer(s) }, '编辑'),
        h('button', { class: 'small danger', onclick: () => removeServer(s) }, '删除')))));
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

  const protoEls = {};
  const grid = h('div', { class: 'proto-grid' });
  for (const [k, label, netw] of PROTOS) {
    const pc = s.protocols[k] || {};
    const en = h('input', { type: 'checkbox', checked: pc.enabled });
    const pt = I(pc.port, { type: 'number' });
    const extra = [];
    const els = { en, pt };
    if (k === 'vlessReality') {
      els.rsni = I(pc.sni, { placeholder: 'www.microsoft.com' });
      extra.push(field('Reality 目标域名（可在工具箱检测）', els.rsni));
      extra.push(h('button', { class: 'small', onclick: async () => { const kp = await api.call('new:reality'); s.protocols.vlessReality.privateKey = kp.privateKey; s.protocols.vlessReality.publicKey = kp.publicKey; toast('已生成新密钥（保存并同步后生效）'); } }, '重新生成密钥'));
    }
    if (k === 'vmess') { els.path = I(pc.path); extra.push(field('WS 路径', els.path)); }
    if (k === 'hysteria2') { els.up = I(pc.upMbps || '', { type: 'number', placeholder: '不限' }); els.down = I(pc.downMbps || '', { type: 'number', placeholder: '不限' }); extra.push(h('div', { class: 'row' }, field('上行 Mbps', els.up), field('下行 Mbps', els.down))); }
    protoEls[k] = els;
    grid.append(h('div', { class: 'proto' }, h('div', { class: 'head' }, h('label', {}, en, ' ', h('b', {}, label)), h('span', { class: 'muted' }, netw.toUpperCase())), field('端口', pt), extra));
  }

  const body = h('div', {},
    h('div', { class: 'row' }, field('名称', name), field('地址', host)),
    h('div', { class: 'row' }, field('SSH 端口', port), field('用户名', user), field('认证方式', auth)),
    pwdBox, keyBox,
    h('div', { class: 'row' }, field('角色', role), field('出口', exit)),
    field('自签证书域名（Trojan/Hy2/TUIC/AnyTLS 的 SNI）', sni),
    h('h4', {}, '协议'), grid);

  const collect = () => {
    s.name = name.value.trim() || host.value.trim();
    s.host = host.value.trim();
    s.sshPort = Number(port.value) || 22;
    s.username = user.value.trim() || 'root';
    s.authType = auth.value; s.password = pwd.value; s.privateKey = key.value; s.passphrase = pass.value;
    s.role = role.value; s.tlsSni = sni.value.trim() || 'www.bing.com';
    s.exit = exit.value ? { type: 'landing', landingId: exit.value } : { type: 'direct' };
    for (const [k] of PROTOS) {
      const e = protoEls[k];
      s.protocols[k] = { ...s.protocols[k], enabled: e.en.checked, port: Number(e.pt.value) };
      if (e.rsni) s.protocols[k].sni = e.rsni.value.trim() || 'www.microsoft.com';
      if (e.path) s.protocols[k].path = e.path.value.trim().startsWith('/') ? e.path.value.trim() : '/' + e.path.value.trim();
      if (e.up) { s.protocols[k].upMbps = Number(e.up.value) || 0; s.protocols[k].downMbps = Number(e.down.value) || 0; }
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
      try { await api.call('server:deploy', s.id); append('✔ 完成'); toast('部署成功', 'ok'); dirty = false; renderBanner(); render(); } catch (e) { append('✘ ' + e.message); } finally { running = false; }
    } },
  ] });
  return m;
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
async function viewUsers(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '用户'), h('p', { class: 'sub' }, '按线路分配、限流量、限到期，每个用户一个订阅地址')), h('div', { class: 'spacer' }),
    h('button', { onclick: (e) => busy(e.currentTarget, async () => { const r = await api.call('users:refreshUsage'); if (r.errors.length) toast(r.errors.join('\n'), 'err'); else toast('流量已刷新', 'ok'); render(); }) }, '刷新流量'),
    h('button', { class: 'primary', onclick: () => editUser() }, '+ 添加用户')));
  const tb = h('tbody');
  for (const u of S.users) {
    const used = userUsed(u);
    const [stText, stCls] = userState(u);
    const pct = u.limitGB > 0 ? Math.min(100, (used / (u.limitGB * GB)) * 100) : 0;
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, u.name), u.note ? h('div', { class: 'muted' }, u.note) : null),
      h('td', {}, h('span', { class: 'tag ' + stCls }, stText)),
      h('td', {}, `${fmtBytes(used)} / ${u.limitGB > 0 ? u.limitGB + ' GB' : '不限'}`, u.limitGB > 0 ? h('div', { class: 'progress' }, h('i', { class: pct >= 100 ? 'full' : '', style: { width: pct + '%' } })) : null),
      h('td', {}, u.expireAt ? fmtDate(u.expireAt) : '永久'),
      h('td', {}, u.serverIds === '*' ? h('span', { class: 'tag blue' }, '全部') : (u.serverIds || []).map((id) => h('span', { class: 'tag' }, serverName(id)))),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: () => showSub(u) }, '订阅'),
        h('button', { class: 'small', onclick: () => editUser(u) }, '编辑'),
        h('button', { class: 'small', onclick: async () => { if (await confirmBox(`把「${u.name}」的已用流量清零？`)) { const r = await api.call('users:resetUsage', u.id); if (r.errors.length) toast(r.errors.join('\n'), 'err'); else toast('已重置', 'ok'); markDirty(); render(); } } }, '重置流量'),
        u.id !== 'owner' ? h('button', { class: 'small danger', onclick: async () => { if (await confirmBox(`删除用户「${u.name}」？同步后立即失效。`)) { await api.call('col:remove', 'users', u.id); markDirty(); render(); } } }, '删除') : null))));
  }
  v.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['用户', '状态', '流量', '到期', '线路', '操作'].map((t) => h('th', {}, t)))), tb)));
  v.append(h('p', { class: 'muted' }, '提示：流量由每台 VPS 上的 agent 精确统计，超额或到期会自动停用（不用开着本软件）。修改用户后记得同步。'));
}

async function editUser(orig) {
  const u = orig ? JSON.parse(JSON.stringify(orig)) : await api.call('new:user', {});
  const name = h('input', { value: u.name });
  const note = h('input', { value: u.note || '', placeholder: '备注（可选）' });
  const limit = h('input', { type: 'number', value: u.limitGB || '', placeholder: '0 = 不限', min: 0, step: 'any' });
  const exp = h('input', { type: 'date', value: u.expireAt ? new Date(u.expireAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '' });
  const quick = h('div', { class: 'actions' }, [['+30天', 30], ['+90天', 90], ['+365天', 365], ['永久', 0]].map(([l, d]) => h('button', { class: 'small', onclick: () => {
    if (!d) { exp.value = ''; return; }
    const base = exp.value ? new Date(exp.value) : new Date();
    base.setDate(base.getDate() + d); exp.value = base.toISOString().slice(0, 10);
  } }, l)));
  const enabled = h('input', { type: 'checkbox', checked: u.enabled });
  const all = h('input', { type: 'checkbox', checked: u.serverIds === '*' });
  const boxes = S.servers.map((s) => ({ s, cb: h('input', { type: 'checkbox', checked: u.serverIds === '*' || (u.serverIds || []).includes(s.id) }) }));
  const list = h('div', {}, boxes.map(({ s, cb }) => h('label', { style: { display: 'block', margin: '4px 0' } }, cb, ' ', s.name, h('span', { class: 'muted' }, ' ' + s.host))));
  const toggleList = () => list.classList.toggle('hidden', all.checked);
  all.onchange = toggleList; toggleList();
  modal({ title: orig ? '编辑用户' : '添加用户', body: h('div', {},
    h('div', { class: 'row' }, field('名称', name), field('备注', note)),
    h('div', { class: 'row' }, field('流量上限（GB）', limit), field('到期日期', exp)), quick,
    h('label', { class: 'f', style: { marginTop: '10px' } }, enabled, ' 启用'),
    h('h4', {}, '可用线路'), h('label', {}, all, ' 全部服务器（以后新加的也包含）'), list), buttons: [
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => {
      u.name = name.value.trim() || '未命名'; u.note = note.value.trim();
      u.limitGB = Number(limit.value) || 0;
      u.expireAt = exp.value ? new Date(exp.value + 'T23:59:59').getTime() : null;
      u.enabled = enabled.checked;
      u.serverIds = all.checked ? '*' : boxes.filter((b) => b.cb.checked).map((b) => b.s.id);
      await api.call('col:upsert', 'users', u); markDirty(); render();
    } },
  ] });
}

async function showSub(u) {
  const r = await api.call('user:sub', u.id);
  const body = h('div', {});
  if (!r.url) body.append(h('p', { class: 'muted' }, '该用户还没有分配到任何服务器。'));
  else {
    body.append(h('div', { class: 'row', style: { alignItems: 'flex-start' } },
      h('img', { class: 'qr auto', src: r.qr }),
      h('div', {},
        field('订阅地址（v2rayN / Shadowrocket / NekoBox）', h('div', { class: 'row' }, h('input', { value: r.url, readonly: true }), h('button', { class: 'auto', onclick: () => copy(r.url) }, '复制'))),
        field('Clash Meta / Mihomo', h('div', { class: 'row' }, h('input', { value: r.clashUrl, readonly: true }), h('button', { class: 'auto', onclick: () => copy(r.clashUrl) }, '复制'))),
        h('p', { class: 'muted' }, `状态：${r.status.reason} · 已用 ${fmtBytes(r.used)}。订阅由 VPS 上的 agent 提供，同步后才会更新。`))));
  }
  body.append(h('h4', {}, `节点链接（${r.links.length}）`), h('textarea', { readonly: true, style: { minHeight: '140px' } }, r.links.join('\n')));
  modal({ title: `${u.name} 的订阅`, wide: true, body, buttons: [{ label: '复制全部链接', onClick: () => copy(r.links.join('\n')) }, { label: '关闭' }] });
}

// ---------- 落地 ----------
async function viewLandings(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '落地'), h('p', { class: 'sub' }, '住宅 IP 等 SOCKS5 / HTTP 代理。在服务器设置里把「出口」选成落地，该服务器所有节点就从落地 IP 出去')), h('div', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: () => editLanding() }, '+ 添加落地')));
  if (!S.landings.length) { v.append(h('div', { class: 'card empty' }, '还没有落地代理')); return; }
  const tb = h('tbody');
  for (const l of S.landings) {
    const res = h('td', { class: 'muted' }, '—');
    const usedBy = S.servers.filter((s) => s.exit?.type === 'landing' && s.exit.landingId === l.id);
    tb.append(h('tr', {},
      h('td', {}, h('b', {}, l.name)), h('td', { class: 'mono' }, `${l.type}://${l.host}:${l.port}`), h('td', {}, usedBy.map((s) => h('span', { class: 'tag' }, s.name))), res,
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: (e) => busy(e.currentTarget, async () => {
          res.textContent = '测试中…';
          const r = await api.call('landing:test', l.id);
          res.innerHTML = '';
          if (!r.ok) res.append(h('span', { class: 'tag bad' }, '不通'), h('div', { class: 'muted' }, r.error));
          else res.append(h('span', { class: 'tag ok' }, r.latency + ' ms'), r.ip ? h('div', {}, `${r.ip.query} ${r.ip.country || ''} ${r.ip.isp || ''} `, h('span', { class: 'tag ' + (r.ip.hosting ? 'warn' : 'ok') }, r.ip.hosting ? '机房IP' : '住宅/非机房')) : null);
        }) }, '测试'),
        h('button', { class: 'small', onclick: () => editLanding(l) }, '编辑'),
        h('button', { class: 'small danger', onclick: async () => { if (await confirmBox(`删除落地「${l.name}」？使用它的服务器会改为直连。`)) { await api.call('col:remove', 'landings', l.id); markDirty(); render(); } } }, '删除')))));
  }
  v.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, ['名称', '地址', '使用中', '测试（从本机直连）', '操作'].map((t) => h('th', {}, t)))), tb)));
}

function editLanding(orig) {
  const l = orig ? { ...orig } : { id: 'l' + Math.random().toString(36).slice(2, 9), type: 'socks', port: 1080 };
  const paste = h('input', { placeholder: '粘贴 ip:端口:用户:密码 或 socks5://用户:密码@ip:端口 自动识别' });
  const name = h('input', { value: l.name || '' });
  const type = h('select', {}, h('option', { value: 'socks' }, 'SOCKS5'), h('option', { value: 'http' }, 'HTTP'));
  type.value = l.type;
  const host = h('input', { value: l.host || '' }), port = h('input', { type: 'number', value: l.port || '' });
  const user = h('input', { value: l.username || '' }), pass = h('input', { value: l.password || '' });
  paste.oninput = () => {
    let s = paste.value.trim();
    const m = s.match(/^(socks5h?|socks|http):\/\//i);
    if (m) { type.value = m[1].toLowerCase().startsWith('http') ? 'http' : 'socks'; s = s.slice(m[0].length); }
    s = s.replace(/#.*$/, '');
    if (s.includes('@')) {
      const at = s.lastIndexOf('@'); const a = s.slice(0, at), hp = s.slice(at + 1);
      const i = a.indexOf(':'); user.value = decodeURIComponent(a.slice(0, i)); pass.value = decodeURIComponent(a.slice(i + 1));
      const j = hp.lastIndexOf(':'); host.value = hp.slice(0, j); port.value = hp.slice(j + 1);
    } else {
      const p = s.split(':');
      if (p.length >= 2) { host.value = p[0]; port.value = p[1]; user.value = p[2] || ''; pass.value = p.slice(3).join(':'); }
    }
    if (!name.value) name.value = host.value;
  };
  modal({ title: orig ? '编辑落地' : '添加落地', body: h('div', {}, field('快速识别', paste), h('div', { class: 'row' }, field('名称', name), field('类型', type)),
    h('div', { class: 'row' }, field('地址', host), field('端口', port)), h('div', { class: 'row' }, field('用户名', user), field('密码', pass))), buttons: [
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async () => {
      Object.assign(l, { name: name.value.trim() || host.value.trim(), type: type.value, host: host.value.trim(), port: Number(port.value), username: user.value, password: pass.value });
      if (!l.host || !l.port) throw new Error('请填写地址和端口');
      await api.call('col:upsert', 'landings', l); markDirty(); render();
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
  const tabs = [['ip', 'IP 画像'], ['ports', '端口检测'], ['dns', 'DNS 查询'], ['trace', '路由追踪'], ['reality', 'Reality 域名检测'], ['socks', 'SOCKS5 转二维码']];
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
  const sbUrl = h('input', { value: st.singboxUrl });
  const autoUp = h('input', { type: 'checkbox', checked: st.autoUpdate !== false });
  v.append(h('h1', {}, '设置'), h('p', { class: 'sub' }, `数据目录：${info.dataDir}`));
  v.append(h('div', { class: 'grid g2' },
    h('div', { class: 'card' }, h('h3', {}, '服务器端'),
      field('订阅端口（对外开放）', subPort),
      h('div', { class: 'row' }, field('统计 API 端口（仅本机）', statsPort), field('agent 管理端口（仅本机）', adminPort)),
      field('sing-box 下载地址（{arch} = amd64/arm64）', sbUrl, '默认从你自己仓库的 GitHub Release 下载带流量统计的 sing-box'),
      h('label', { class: 'f' }, autoUp, ' 自动检查软件更新'),
      h('button', { class: 'primary', onclick: async () => {
        await api.call('settings:set', { subPort: Number(subPort.value) || 2096, statsPort: Number(statsPort.value) || 9092, adminPort: Number(adminPort.value) || 9091, singboxUrl: sbUrl.value.trim(), autoUpdate: autoUp.checked });
        toast('已保存。改了端口需要重新部署服务器', 'ok'); markDirty();
      } }, '保存')),
    h('div', {}, updateCard(),
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
    if (st.state === 'available' && prev !== 'available') toast(`发现新版本 ${st.latest}，可在「设置」里更新`);
    if (st.state === 'downloaded' && prev !== 'downloaded') toast('更新已下载，点击左下角重启安装', 'ok');
    if (prev !== st.state && (page === 'settings' || page === 'dash')) render();
  });
  await reload();
  renderNav();
  render();
})();
