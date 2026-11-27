'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

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
  if (!S.landings.length) { v.append(emptyState('还没有落地', '想让节点从住宅 IP 或别的机场出去（解锁流媒体、换地区），先在这里添加；再到服务器设置里把「出口」选成它。', h('button', { class: 'primary', onclick: () => editLanding() }, '+ 添加落地'), h('button', { onclick: () => importLandings('sub') }, '从订阅导入'))); return; }
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

// ---------- 端口转发（中转） ----------
// 转发由中转机上的 agent 做（参考 realm / gost）：TCP + UDP、多个目标主备或轮询、目标探测、按规则统计流量、来源 IP 白名单
const FWD_NET = { '': 'TCP+UDP', tcp: 'TCP', udp: 'UDP', both: 'TCP+UDP' };
const PROTO_NET = Object.fromEntries(PROTOS.map(([k, , n]) => [k, n === 'tcp+udp' ? 'both' : n]));
let fwdStatusCache = null;

function fwdTargetsOf(f) {
  const t = f.target || {};
  if (t.type === 'node') {
    const s = S.servers.find((x) => x.id === t.serverId);
    const pc = s?.protocols?.[t.protocol];
    return s && pc ? [`${s.host.includes(':') ? `[${s.host}]` : s.host}:${pc.port}`] : [];
  }
  return (Array.isArray(t.targets) && t.targets.length ? t.targets : t.host ? [`${t.host}:${t.port}`] : []);
}
const fwdNet = (f) => (f.target?.type === 'node' ? (PROTO_NET[f.target.protocol] || 'tcp') : (f.target?.network || ''));

// 端口转发的目标是明文代理（HTTP / Socks）又没填来源白名单：拦下，解释原因和改法
const PROXY_KIND = { socks5: 'Socks5', socks4: 'Socks4', http: 'HTTP' };
function proxyExposedBox(hits, onWhitelist, closeEditor) {
  modal({ title: '这条转发会把明文代理暴露到公网', body: h('div', { style: { lineHeight: 1.7 } },
    h('p', { style: { marginTop: 0 } }, '中转机检测到这些目标是不加密的代理：', h('br'), hits.map((x) => h('div', { class: 'mono' }, `${x.target}（${PROXY_KIND[x.kind] || x.kind} 代理）`))),
    h('p', {}, '端口转发会把它原样开到公网：任何人扫到这个端口都能拿来当代理用，就算设了密码也是明文传的。很多服务商明令禁止，发现会停机，IP 也会被别人滥用。'),
    h('p', {}, h('b', {}, '推荐：'), '到「落地」里添加这个代理，再在服务器的「出口」里选它。这样你用加密节点连 VPS，由 VPS 去连这个代理，不对公网开放任何端口。'),
    h('p', { style: { marginBottom: 0 } }, h('b', {}, '一定要转发的话：'), '在「来源 IP 白名单」里只填自己的 IP 或中转机 IP，VPS 防火墙只放行这些地址。')),
  buttons: [{ label: '去添加落地', onClick: () => { if (closeEditor) closeEditor(); go('landings'); } }, { label: '填白名单', class: 'primary', onClick: () => onWhitelist && onWhitelist() }] });
}

// 已有的端口转发：逐台中转机探测目标，列出会把明文代理暴露到公网的
async function checkExposedProxies(all) {
  const todo = all.filter((f) => f.enabled !== false && !(f.allow || []).length && f.target?.network !== 'udp');
  if (!todo.length) { toast('没有需要检查的转发（填了来源白名单或只转 UDP 的不查）', 'ok'); return; }
  const found = []; const warns = [];
  const byRelay = new Map();
  for (const f of todo) { if (!byRelay.has(f.relayServerId)) byRelay.set(f.relayServerId, []); byRelay.get(f.relayServerId).push(f); }
  for (const [rid, list] of byRelay) {
    const pr = await api.call('forward:probe', rid, list.flatMap((f) => fwdTargetsOf(f)));
    if (pr.warn) { warns.push(`${serverName(rid)}：${pr.warn}`); continue; }
    const bad = new Map((pr.results || []).filter((x) => x.kind).map((x) => [x.target, x.kind]));
    for (const f of list) { const t = fwdTargetsOf(f).find((x) => bad.has(x)); if (t) found.push({ f, target: t, kind: bad.get(t) }); }
  }
  if (!found.length) { toast(warns.length ? '没发现明文代理，但有的中转机没查成：\n' + warns.join('\n') : `检查了 ${todo.length} 条，没有把明文代理暴露到公网的`, warns.length ? 'warn' : 'ok'); return; }
  const m = modal({ title: `有 ${found.length} 条转发把明文代理暴露到了公网`, wide: true, body: h('div', {},
    h('p', { class: 'muted', style: { marginTop: 0 } }, '这些转发的目标是不加密的 HTTP / Socks 代理，又没填来源白名单：任何人扫到入口端口都能拿来当代理用，服务商会停机、IP 会被滥用。改成「落地」最好；一定要转发就编辑它、填上来源 IP 白名单；暂时不用可以先停用。'),
    h('table', {}, h('thead', {}, h('tr', {}, ['中转机', '入口', '目标', ''].map((t) => h('th', {}, t)))), h('tbody', {}, found.map(({ f, target, kind }) => h('tr', {},
      h('td', {}, serverName(f.relayServerId)), h('td', { class: 'mono' }, String(f.listenPort)), h('td', { class: 'mono' }, `${target}（${PROXY_KIND[kind] || kind}）`),
      h('td', { class: 'nowrap' }, h('div', { class: 'actions nowrap' },
        h('button', { class: 'small', onclick: () => { m.close(); editForward(f, false, null, 'custom'); } }, '填白名单'),
        h('button', { class: 'small', onclick: (e) => { const b = e.currentTarget; busy(b, async () => { await api.call('col:upsert', 'forwards', { ...f, enabled: false }); syncRelay(f.relayServerId, '已停用'); }).then(() => { b.textContent = '已停用'; b.disabled = true; }); } }, '停用'))))))),
    warns.length ? h('p', { class: 'muted' }, '没查成：' + warns.join('；')) : null),
  onClose: () => render(), buttons: [{ label: '关闭' }] });
}

async function syncRelay(relayId, what) {
  const relay = S.servers.find((x) => x.id === relayId);
  if (!relay?.deployedAt) { toast(what + '。中转机还没部署，部署后生效', 'ok'); return; }
  toast(what + '，正在同步到 ' + relay.name + '…');
  try { await api.call('server:sync', relayId); toast(what + '，已同步到 ' + relay.name, 'ok'); } catch (e) { markDirty(); toast(what + '，但同步失败：' + e.message + '\n稍后点「同步全部」', 'err'); }
}

// 中转和端口转发共用一张表：中转 = 目标是节点（订阅里自动多一条经中转的线路）；端口转发 = 目标是任意地址
async function viewRelays(v) { return fwdPage(v, 'node'); }
async function viewForwards(v) { return fwdPage(v, 'custom'); }

async function fwdPage(v, mode) {
  await reload();
  const isRelay = mode === 'node';
  const all = S.forwards.filter((f) => (f.target?.type === 'node') === isRelay);
  const refreshBtn = h('button', {}, '刷新状态');
  const addBtn = () => h('button', { class: 'primary', onclick: () => (isRelay ? addRelays() : editForward(null, false, null, 'custom')) }, isRelay ? '+ 添加中转' : '+ 添加转发');
  v.append(h('div', { class: 'toolbar' }, h('div', {},
    h('h1', {}, isRelay ? '中转' : '端口转发'),
    h('p', { class: 'sub' }, isRelay
      ? '用一台国内直连好的 VPS 转发到节点：节点 IP 被墙、或者直连太慢时用。用户订阅里自动多一条「经中转」的线路，和直连线路并存。'
      : '在一台 VPS 上开个端口，把 TCP / UDP 转到任意地址（别的机器、内网服务、游戏服等）。不会加进订阅。')), h('div', { class: 'spacer' }),
    all.length ? refreshBtn : null,
    !isRelay && all.length ? h('button', { title: '让中转机探测每条转发的目标是不是 HTTP / Socks 明文代理（没填来源白名单的才查）', onclick: (e) => busy(e.currentTarget, () => checkExposedProxies(all)) }, '检查明文代理') : null,
    isRelay ? null : h('button', { onclick: () => batchForwards() }, '批量添加'),
    addBtn()));
  if (!all.length) {
    v.append(isRelay
      ? emptyState('还没有中转', '选一台中转机和要中转的节点，一次可以勾好几个协议，入口端口自动分配。', addBtn())
      : emptyState('还没有端口转发', '比如把这台 VPS 的 30001 端口转到另一台机器的 22 端口。可以填多个目标做主备或轮询，也能限制只让某些 IP 连。', addBtn(), h('button', { onclick: () => batchForwards() }, '批量添加')));
    return;
  }
  const cells = {};
  const relayErr = {};
  const byRelay = new Map();
  for (const f of all) { if (!byRelay.has(f.relayServerId)) byRelay.set(f.relayServerId, []); byRelay.get(f.relayServerId).push(f); }
  for (const [rid, list] of byRelay) {
    const relay = S.servers.find((s) => s.id === rid);
    const tb = h('tbody');
    for (const f of list.sort((a, b) => (isRelay ? serverName(a.target.serverId).localeCompare(serverName(b.target.serverId)) || 0 : 0) || a.listenPort - b.listenPort)) {
      const targets = fwdTargetsOf(f);
      const c = { traffic: h('td', { class: 'nowrap muted' }, '—'), conns: h('td', { class: 'nowrap muted' }, '—'), targets: h('div', { class: 'fw-targets' }) };
      cells[f.id] = { f, ...c, list: targets };
      const off = f.enabled === false;
      const entry = `${relay?.host || '?'}:${f.listenPort}`;
      const first = isRelay
        ? h('td', {}, h('b', {}, serverName(f.target.serverId)), h('div', { class: 'muted fw-sub' }, PROTO_LABEL[f.target.protocol] || f.target.protocol, f.name ? ` · ${f.name}` : ''))
        : h('td', {}, h('b', {}, f.name || '未命名'), (f.allow || []).length ? h('div', { class: 'fw-sub' }, h('span', { class: 'tag', title: f.allow.join('\n') }, `只允许 ${f.allow.length} 个来源`)) : null);
      tb.append(h('tr', { class: off ? 'fw-off' : '' },
        first,
        h('td', { class: 'nowrap' }, h('span', { class: 'mono fw-port', title: '点击复制 ' + entry, onclick: () => copy(entry) }, ':' + f.listenPort), ' ', h('span', { class: 'tag' }, FWD_NET[fwdNet(f)] || 'TCP+UDP')),
        h('td', {}, c.targets, !isRelay && targets.length > 1 ? h('div', { class: 'fw-meta' }, h('span', { class: 'tag blue' }, f.strategy === 'roundrobin' ? '轮询' : '主备')) : null),
        c.traffic, c.conns,
        h('td', {}, h('button', { class: 'small fw-toggle ' + (off ? '' : 'on'), title: off ? '点击启用' : '点击停用', onclick: (ev) => busy(ev.currentTarget, async () => { await api.call('col:upsert', 'forwards', { ...f, enabled: off }); await syncRelay(rid, off ? '已启用' : '已停用'); render(); }) }, off ? '已停用' : '运行中')),
        h('td', { class: 'nowrap' }, h('div', { class: 'actions nowrap' },
          h('button', { class: 'small', onclick: () => editForward(f, false, null, mode) }, '编辑'),
          h('button', { class: 'small', onclick: (ev) => { const b = ev.currentTarget; menu(b, [
            { label: '复制入口地址', onClick: () => copy(entry) },
            isRelay ? null : { label: '复制一条一样的', onClick: () => editForward({ ...f, id: undefined, name: (f.name || '') + ' 副本', listenPort: 30000 + Math.floor(Math.random() * 20000) }, true, null, mode) },
            { label: '流量清零', onClick: async () => { if (await confirmBox(`把 ${entry} 的流量统计清零？`)) { await api.call('fwd:reset', f.id); toast('已清零', 'ok'); loadStatus(); } } },
            { sep: true },
            { label: '删除', danger: true, onClick: async () => { if (await confirmBox(`删除 ${entry}？${isRelay ? '\n\n用户订阅里经这台中转的这条线路也会去掉，节点本身不受影响。' : ''}`, '删除')) { await api.call('col:remove', 'forwards', f.id); await syncRelay(rid, '已删除'); render(); } } },
          ]); } }, '更多 ▾')))));
    }
    relayErr[rid] = h('span', { class: 'muted' });
    v.append(h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('span', { class: 'muted' }, isRelay ? '中转机' : '在'), h('h3', { style: { margin: 0 } }, relay?.name || '（服务器已删除）'), h('span', { class: 'muted mono' }, relay?.host || ''), relay && !relay.deployedAt ? h('span', { class: 'tag warn' }, '未部署') : null, h('span', { class: 'muted' }, `${list.length} 条`), relayErr[rid], h('div', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => (isRelay ? addRelays(rid) : editForward(null, false, rid, 'custom')) }, '+ 在这台添加')),
      h('table', { class: 'fw-table' }, h('thead', {}, h('tr', {}, [isRelay ? '节点' : '名称', '入口端口', isRelay ? '中转机 → 节点' : '目标', '流量 ↑ / ↓', '连接', '状态', ''].map((t) => h('th', {}, t)))), tb)));
  }
  v.append(h('p', { class: 'muted', style: { fontSize: '12px' } }, '圆点：绿 = 中转机连得上目标（后面是中转机到目标的延迟），红 = 连不上，灰 = 还没探测（只转 UDP 的不探测）。中转机每 30 秒探测一次。'));

  function fill(st) {
    for (const [id, c] of Object.entries(cells)) {
      const r = st?.rules?.[id];
      const tmap = Object.fromEntries((r?.targets || []).map((t) => [t.addr, t]));
      c.targets.replaceChildren(...c.list.map((addr) => {
        const t = tmap[addr];
        const cls = !t || !t.at ? '' : t.ok ? 'ok' : 'bad';
        return h('div', { class: 'fw-t', title: t?.error || '' }, h('i', { class: 'fw-dot ' + cls }), h('span', { class: 'mono' }, addr), t?.ok ? h('span', { class: 'muted' }, ` ${t.ms.toFixed(0)} ms`) : t?.at ? h('span', { class: 'fw-err' }, ' 连不上') : null);
      }));
      if (r) {
        c.traffic.className = 'nowrap'; c.traffic.replaceChildren(`↑ ${fmtBytes(r.up)}`, h('br'), `↓ ${fmtBytes(r.down)}`);
        c.conns.className = 'nowrap'; c.conns.replaceChildren(String(r.conns), h('div', { class: 'muted fw-sub' }, `累计 ${r.total}`));
        if (r.error) c.traffic.append(h('div', { class: 'fw-err', title: r.error }, '端口开不了'));
      }
    }
    for (const [rid, el] of Object.entries(relayErr)) el.replaceChildren(st?.errors?.[rid] ? h('span', { class: 'tag bad', title: st.errors[rid] }, '读不到状态') : '');
  }
  async function loadStatus() {
    refreshBtn.disabled = true;
    try { fwdStatusCache = await api.call('fwd:status'); fill(fwdStatusCache); } catch (e) { toast(e.message, 'err'); } finally { refreshBtn.disabled = false; }
  }
  refreshBtn.onclick = loadStatus;
  fill(fwdStatusCache);
  loadStatus();
}

// 添加中转：选中转机和节点服务器，可以一次勾好几个协议，入口端口自动分配（尽量和节点端口一样）
function addRelays(relayPreset) {
  if (S.servers.length < 2) { toast('至少要有两台服务器：一台当中转，一台当节点', 'err'); return; }
  const relay = h('select', {}, S.servers.map((s) => h('option', { value: s.id }, `${s.name} (${s.host})`)));
  relay.value = relayPreset || (S.servers.find((s) => s.role === 'relay') || S.servers[0]).id;
  const tsrv = h('select', {});
  const protoBox = h('div', { class: 'fw-protos' });
  const samePort = h('input', { type: 'checkbox', checked: true });
  const fillT = () => {
    const cur = tsrv.value;
    tsrv.replaceChildren(...S.servers.filter((s) => s.id !== relay.value).map((s) => h('option', { value: s.id }, s.name)));
    if (cur && [...tsrv.options].some((o) => o.value === cur)) tsrv.value = cur;
    fillP();
  };
  const fillP = () => {
    const s = S.servers.find((x) => x.id === tsrv.value);
    const have = new Set(S.forwards.filter((f) => f.relayServerId === relay.value && f.target?.serverId === tsrv.value).map((f) => f.target.protocol));
    protoBox.replaceChildren(...PROTOS.filter(([k]) => s?.protocols?.[k]?.enabled).map(([k, l]) => {
      const cb = h('input', { type: 'checkbox', value: k, checked: !have.has(k), disabled: have.has(k) });
      return h('label', { class: 'fw-proto' + (have.has(k) ? ' muted' : '') }, cb, ` ${l}`, h('span', { class: 'muted mono' }, ` :${s.protocols[k].port}`), have.has(k) ? h('span', { class: 'muted' }, '（已有中转）') : null);
    }));
    if (!protoBox.children.length) protoBox.append(h('span', { class: 'muted' }, '这台没有启用的协议'));
  };
  relay.onchange = fillT; tsrv.onchange = fillP; fillT();
  modal({ title: '添加中转', body: h('div', {},
    h('div', { class: 'row' }, field('中转机', relay, '国内连得快的那台'), field('节点服务器', tsrv, '被墙或者直连慢的那台')),
    field('要中转的协议', protoBox),
    chk(samePort, '入口端口尽量和节点一样', '中转机上这个端口被占了就随机换一个')), buttons: [
    { label: '取消' },
    { label: '添加', class: 'primary', onClick: async () => {
      const keys = [...protoBox.querySelectorAll('input:checked:not(:disabled)')].map((x) => x.value);
      if (!keys.length) throw new Error('勾选至少一个协议');
      const rs = S.servers.find((x) => x.id === relay.value);
      const ts = S.servers.find((x) => x.id === tsrv.value);
      const used = new Set([...S.forwards.filter((x) => x.relayServerId === rs.id).map((x) => Number(x.listenPort)), ...Object.values(rs.protocols || {}).filter((p) => p?.enabled).map((p) => Number(p.port)), Number(S.settings.subPort || 2096)]);
      for (const k of keys) {
        let port = samePort.checked ? Number(ts.protocols[k].port) : 0;
        while (!port || used.has(port)) port = 30000 + Math.floor(Math.random() * 20000);
        used.add(port);
        await api.call('col:upsert', 'forwards', { id: 'f' + Math.random().toString(36).slice(2, 9), relayServerId: rs.id, listenPort: port, enabled: true, name: '', target: { type: 'node', serverId: ts.id, protocol: k }, allow: [] });
      }
      render();
      syncRelay(rs.id, `已添加 ${keys.length} 条中转`);
    } },
  ] });
}

function editForward(orig, copyOf = false, relayPreset, mode) {
  if (!S.servers.length) { toast('请先添加服务器', 'err'); return; }
  const isNew = !orig || copyOf;
  const f = orig ? JSON.parse(JSON.stringify(orig)) : { listenPort: 30000 + Math.floor(Math.random() * 20000), target: { type: mode || 'custom' }, enabled: true };
  if (isNew) f.id = 'f' + Math.random().toString(36).slice(2, 9);
  const name = h('input', { value: f.name || '', placeholder: '可选，例如：香港中转→美国' });
  const relay = h('select', {}, S.servers.map((s) => h('option', { value: s.id }, `${s.name} (${s.host})`)));
  relay.value = relayPreset || f.relayServerId || (S.servers.find((s) => s.role === 'relay') || S.servers[0]).id;
  const lp = h('input', { type: 'number', min: 1, max: 65535, value: f.listenPort });
  const rnd = h('button', { class: 'auto', title: '换一个随机端口', onclick: () => { lp.value = 30000 + Math.floor(Math.random() * 20000); } }, '随机');
  const ttype = h('select', {}, h('option', { value: 'node' }, '节点（自动加进用户订阅）'), h('option', { value: 'custom' }, '自定义地址'));
  ttype.value = f.target.type || 'node';
  const tsrv = h('select', {}, S.servers.map((s) => h('option', { value: s.id }, s.name)));
  if (f.target.serverId) tsrv.value = f.target.serverId;
  const tproto = h('select', {});
  const fillProto = () => {
    const s = S.servers.find((x) => x.id === tsrv.value);
    tproto.innerHTML = '';
    for (const [k, l] of PROTOS) if (s?.protocols?.[k]?.enabled) tproto.append(h('option', { value: k }, `${l}（${s.protocols[k].port}）`));
    if (f.target.protocol) tproto.value = f.target.protocol;
  };
  tsrv.onchange = fillProto; fillProto();
  const tlist = h('textarea', { rows: 3, placeholder: '一行一个，例如\n1.2.3.4:443\nexample.com:8080', class: 'mono' }, fwdTargetsOf(f.target.type === 'custom' ? f : { target: {} }).join('\n'));
  const tnet = h('select', {}, h('option', { value: '' }, 'TCP + UDP'), h('option', { value: 'tcp' }, '只转 TCP'), h('option', { value: 'udp' }, '只转 UDP'));
  tnet.value = f.target.network || '';
  const strat = h('select', {}, h('option', { value: 'failover' }, '主备：先用第一个，连不上换下一个'), h('option', { value: 'roundrobin' }, '轮询：每个连接轮流用'));
  strat.value = f.strategy === 'roundrobin' ? 'roundrobin' : 'failover';
  const stratRow = field('多个目标时', strat);
  const allow = h('textarea', { rows: 2, placeholder: '留空 = 谁都能连。一行一个 IP 或网段，例如\n110.0.0.0/8', class: 'mono' }, (f.allow || []).join('\n'));
  const en = h('input', { type: 'checkbox', checked: f.enabled !== false });
  const nodeBox = h('div', { class: 'row' }, field('目标服务器', tsrv), field('协议', tproto));
  const customBox = h('div', {}, field('目标地址', tlist, '可以填多个，中转机会探测哪个连得上'), h('div', { class: 'row' }, field('转发', tnet), stratRow));
  const syncStrat = () => stratRow.classList.toggle('hidden', tlist.value.split('\n').filter((x) => x.trim()).length < 2);
  tlist.oninput = syncStrat; syncStrat();
  const sw = () => { nodeBox.classList.toggle('hidden', ttype.value !== 'node'); customBox.classList.toggle('hidden', ttype.value !== 'custom'); };
  ttype.onchange = sw; sw();
  const adv = h('details', { class: 'fw-adv' }, h('summary', {}, '来源 IP 白名单（可选）'), field('只允许这些来源', allow, '比如只给自己家宽或某台机器用。在 VPS 防火墙层面拦，别人扫端口也看不到。入口用 80 / 443 / 8080 / 8443 时必须填'));
  if ((f.allow || []).length) adv.open = true;
  modal({ title: (f.target.type === 'node' ? (isNew ? '添加中转' : '编辑中转') : (isNew ? '添加转发' : '编辑转发')), body: h('div', {},
    h('div', { class: 'row' }, field('中转服务器', relay), field('入口端口', h('div', { class: 'row' }, lp, rnd))),
    mode ? null : field('转到', ttype), nodeBox, customBox, field(f.target.type === 'node' ? '备注（可选）' : '名称', name), f.target.type === 'node' ? null : adv, chk(en, '启用')), buttons: [
    { label: '取消' },
    { label: '保存', class: 'primary', onClick: async (closeEditor) => {
      f.name = name.value.trim(); f.relayServerId = relay.value; f.listenPort = Number(lp.value); f.enabled = en.checked;
      if (!(f.listenPort >= 1 && f.listenPort <= 65535)) throw new Error('入口端口要在 1–65535 之间');
      if (ttype.value === 'node') f.target = { type: 'node', serverId: tsrv.value, protocol: tproto.value };
      else {
        const list = tlist.value.split('\n').map((x) => x.trim()).filter(Boolean);
        const bad = list.find((x) => !/^(\[[0-9a-fA-F:.]+\]|[^\s:/]+|[0-9a-fA-F:]+):\d{1,5}$/.test(x));
        if (!list.length) throw new Error('请填写目标地址和端口，例如 1.2.3.4:443');
        if (bad) throw new Error(`目标格式不对：${bad}（要写成 地址:端口）`);
        const m = list[0].match(/^(.*):(\d+)$/);
        f.target = { type: 'custom', host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), network: tnet.value, targets: list };
        f.strategy = strat.value;
      }
      f.allow = allow.value.split('\n').map((x) => x.trim()).filter(Boolean);
      const badIp = f.allow.find((x) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x));
      if (badIp) throw new Error(`白名单格式不对：${badIp}`);
      if (S.settings.avoidWebPorts !== false && WEB_PORTS.includes(f.listenPort) && !f.allow.length) { adv.open = true; throw new Error(`入口端口 ${f.listenPort} 是常用 Web 端口（80 / 443 / 8080 / 8443），很多服务商不允许对公网开放。换一个，或者在「来源 IP 白名单」里填上允许连接的 IP（只对这些 IP 开放）`); }
      if (f.target.type === 'node' && !f.target.protocol) throw new Error('目标服务器没有启用协议');
      if (f.target.type === 'node' && f.target.serverId === f.relayServerId) throw new Error('中转机和目标不能是同一台');
      if (f.target.type === 'custom' && !f.allow.length && f.target.network !== 'udp') {
        const pr = await api.call('forward:probe', f.relayServerId, f.target.targets || []);
        const hits = (pr.results || []).filter((x) => x.kind);
        if (hits.length) { proxyExposedBox(hits, () => { adv.open = true; allow.focus(); }, closeEditor); return false; }
        if (pr.warn) toast(pr.warn, 'warn');
      }
      const clash = S.forwards.find((x) => x.id !== f.id && x.relayServerId === f.relayServerId && Number(x.listenPort) === f.listenPort);
      if (clash) throw new Error(`这台中转机的 ${f.listenPort} 端口已经被「${clash.name || '另一条转发'}」用了`);
      const rs = S.servers.find((x) => x.id === f.relayServerId);
      const used = Object.entries(rs?.protocols || {}).find(([, p]) => p?.enabled && Number(p.port) === f.listenPort);
      if (used) throw new Error(`${f.listenPort} 端口是这台的 ${PROTO_LABEL[used[0]] || used[0]} 在用，换一个`);
      await api.call('col:upsert', 'forwards', f);
      render();
      syncRelay(f.relayServerId, isNew ? '已添加' : '已保存');
    } },
  ] });
}

// 批量添加：一行一条「入口端口 目标地址:端口 [tcp|udp]」
function batchForwards() {
  if (!S.servers.length) { toast('请先添加服务器', 'err'); return; }
  const relay = h('select', {}, S.servers.map((s) => h('option', { value: s.id }, `${s.name} (${s.host})`)));
  relay.value = (S.servers.find((s) => s.role === 'relay') || S.servers[0]).id;
  const ta = h('textarea', { rows: 8, class: 'mono', placeholder: '一行一条：入口端口 目标地址:端口 [tcp|udp]\n30001 1.2.3.4:443\n30002 example.com:8080 tcp\n30003 5.6.7.8:53 udp' });
  modal({ title: '批量添加转发', wide: true, body: h('div', {}, field('中转服务器', relay), field('规则', ta, '不写 tcp / udp 就两种都转。入口端口重复的会跳过')), buttons: [
    { label: '取消' },
    { label: '添加', class: 'primary', onClick: async () => {
      const out = []; const errs = [];
      const usedPorts = new Set(S.forwards.filter((x) => x.relayServerId === relay.value).map((x) => Number(x.listenPort)));
      ta.value.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')).forEach((line, i) => {
        const m = line.match(/^(\d{1,5})\s+(\S+):(\d{1,5})(?:\s+(tcp|udp))?$/i);
        if (!m) { errs.push(`第 ${i + 1} 行格式不对：${line}`); return; }
        const lp = Number(m[1]);
        if (usedPorts.has(lp)) { errs.push(`第 ${i + 1} 行：入口端口 ${lp} 已经有了`); return; }
        if (S.settings.avoidWebPorts !== false && WEB_PORTS.includes(lp)) { errs.push(`第 ${i + 1} 行：入口端口 ${lp} 是常用 Web 端口，很多服务商不允许对公网开放；要用的话单独添加并填来源 IP 白名单`); return; }
        usedPorts.add(lp);
        const host = m[2].replace(/^\[|\]$/g, '');
        out.push({ id: 'f' + Math.random().toString(36).slice(2, 9), relayServerId: relay.value, listenPort: lp, enabled: true, name: '', target: { type: 'custom', host, port: Number(m[3]), network: (m[4] || '').toLowerCase(), targets: [`${m[2]}:${m[3]}`] }, strategy: 'failover', allow: [] });
      });
      if (!out.length) throw new Error(errs.join('\n') || '没有可添加的规则');
      // 批量添加没有白名单：目标是明文代理的跳过
      const tcpOnes = out.filter((f) => f.target.network !== 'udp');
      if (tcpOnes.length) {
        const pr = await api.call('forward:probe', relay.value, tcpOnes.map((f) => f.target.targets[0]));
        const bad = new Map((pr.results || []).filter((x) => x.kind).map((x) => [x.target, x.kind]));
        if (pr.warn) toast(pr.warn, 'warn');
        for (let i = out.length - 1; i >= 0; i--) {
          const k = out[i].target.network !== 'udp' && bad.get(out[i].target.targets[0]);
          if (k) { errs.push(`入口 ${out[i].listenPort}：目标 ${out[i].target.targets[0]} 是 ${PROXY_KIND[k] || k} 明文代理，转发出去等于对公网开放，已跳过（改用「落地」，或单独添加并填来源 IP 白名单）`); out.splice(i, 1); }
        }
        if (!out.length) throw new Error(errs.join('\n'));
      }
      for (const f of out) await api.call('col:upsert', 'forwards', f);
      if (errs.length) toast(`跳过了 ${errs.length} 行：\n` + errs.join('\n'), 'warn');
      render();
      syncRelay(relay.value, `已添加 ${out.length} 条`);
    } },
  ] });
}
