'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → settings.js（最后一个启动界面）

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
      h('td', {}, h('b', {}, l.name), l.group ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, l.group) : null),
      h('td', {}, h('span', { class: 'tag' }, LANDING_TYPE[l.type] || l.type), h('div', { class: 'mono muted' }, landingAddr(l))),
      h('td', {}, usedBy.map((s) => h('span', { class: 'tag' }, s.name))), res,
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'small primary', onclick: (e) => busy(e.currentTarget, async () => {
          res.textContent = '测试中…';
          testResultView(res, await api.call('landing:test', l.id));
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
