'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

// ---------- 节点 ----------
// 测试结果按入口记住（重新进页面、切页面都还在；存在本机浏览器存储里，重启软件也在）
const nodeKey = (e) => [e.serverId, e.protocol, e.host, e.port, e.via || ''].join('|');
let NODE_RES = {};
try { NODE_RES = JSON.parse(localStorage.getItem('nodeResults') || '{}'); } catch (_) { NODE_RES = {}; }
const saveNodeRes = () => { try { localStorage.setItem('nodeResults', JSON.stringify(NODE_RES)); } catch (_) { /* 存不了就算了 */ } };

const latClass = (ms) => (ms < 250 ? 'ok' : ms < 600 ? 'blue' : 'warn');

// 一个入口的三格：延迟 / 速度 / 出口。没测过显示「测」按钮，测过显示结果（点结果重测）
function nodeCells(e) {
  const cells = { lat: h('td', { class: 'nt-cell' }), speed: h('td', { class: 'nt-cell' }), exit: h('td', { class: 'nt-cell' }) };
  const test = async (kind) => {
    const r0 = NODE_RES[nodeKey(e)] || {};
    for (const k of kind === 'speed' ? ['speed'] : kind === 'exit' ? ['exit'] : ['lat']) cells[k].replaceChildren(h('span', { class: 'spin' }));
    const r = await api.call('node:test', e, 'owner', { latency: true, exit: kind === 'exit', speed: kind === 'speed' });
    const res = { ...r0, at: Date.now() };
    res.lat = r.ok ? { ms: r.latency } : { error: r.error };
    if (kind === 'exit') res.exit = r.ok ? (r.ip ? { ip: r.ip } : { error: r.ipError || '查不到' }) : { error: '不通' };
    if (kind === 'speed') res.speed = r.ok ? r.speed : { error: '不通' };
    NODE_RES[nodeKey(e)] = res; saveNodeRes();
    draw();
    return res;
  };
  const btn = (kind) => h('button', { class: 'small nt-btn', title: { lat: '测延迟（经这个节点请求 generate_204，取两次里较快的）', speed: '测速（经这个节点下载 8 秒）', exit: '查出口 IP' }[kind], onclick: (ev) => busy(ev.currentTarget, () => test(kind)) }, '测');
  const again = (kind, el) => { el.classList.add('nt-again'); el.title = (el.title ? el.title + '\n' : '') + '点击重测'; el.onclick = () => { el.onclick = null; test(kind); }; return el; };
  function draw() {
    const r = NODE_RES[nodeKey(e)] || {};
    cells.lat.replaceChildren(!r.lat ? btn('lat') : r.lat.error
      ? again('lat', h('span', { class: 'tag bad', title: r.lat.error }, '不通'))
      : again('lat', h('span', { class: 'tag ' + latClass(r.lat.ms) }, `${r.lat.ms} ms`)));
    cells.speed.replaceChildren(!r.speed ? btn('speed') : r.speed.error
      ? again('speed', r.speed.error === '不通' ? h('span', { class: 'muted', title: '节点不通，测不了速度' }, '—') : h('span', { class: 'tag bad', title: r.speed.error }, '失败'))
      : again('speed', h('span', { class: 'nt-num', title: `测速来源：${r.speed.source || ''}` }, r.speed.mbps >= 100 ? r.speed.mbps.toFixed(0) : r.speed.mbps.toFixed(1), h('small', {}, ' Mbps'))));
    const ip = r.exit?.ip;
    cells.exit.replaceChildren(!r.exit ? btn('exit') : r.exit.error
      ? again('exit', r.exit.error === '不通' ? h('span', { class: 'muted', title: '节点不通，查不了出口' }, '—') : h('span', { class: 'tag bad', title: r.exit.error }, '查不到'))
      : again('exit', h('span', { class: 'nt-exit', title: [ip.query, ip.country, ip.city, ip.isp, ip.hosting ? '机房 IP' : '非机房 IP'].filter(Boolean).join(' · ') },
        ip.countryCode ? h('span', { class: 'nt-cc' }, ip.countryCode) : null, h('span', {}, ip.country || ip.query), ip.hosting ? null : h('span', { class: 'tag ok' }, '住宅'))));
  }
  draw();
  return { cells, test, draw };
}

// 一组入口一起测：延迟和出口并发（最多 4 个），速度一个一个测（同时测会互相抢带宽）
async function testMany(rows, kinds, btn, label) {
  const old = btn.textContent;
  btn.disabled = true;
  try {
    let done = 0;
    const total = rows.length * kinds.length;
    const tick = () => { btn.textContent = `${label} ${done}/${total}`; };
    tick();
    for (const kind of kinds) {
      const queue = rows.slice();
      const width = kind === 'speed' ? 1 : 4;
      await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
        while (queue.length) { const r = queue.shift(); try { await r.test(kind); } catch (_) { /* 单个失败不影响其它 */ } done++; tick(); }
      }));
    }
  } finally { btn.textContent = old; btn.disabled = false; }
}

async function viewNodes(v) {
  await reload();
  const groups = await api.call('nodes:list');
  const allRows = [];
  const topBtns = h('div', { class: 'actions' });
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '节点'), h('p', { class: 'sub' }, '默认用户（自用）的链接。延迟、速度、出口都是从这台电脑经节点实测的；给别人用请在「用户」里创建并发订阅。')), h('div', { class: 'spacer' }), topBtns));
  if (!groups.length) { v.append(emptyState('还没有节点', '节点在服务器部署好之后自动生成。', h('button', { class: 'primary', onclick: () => go('servers') }, '去添加服务器'))); return; }
  for (const g of groups) {
    const tb = h('tbody');
    const rows = [];
    for (const e of g.entries) {
      const row = nodeCells(e);
      rows.push(row); allRows.push(row);
      const pname = PROTO_LABEL[e.protocol] || e.protocol;
      const showName = e.label.startsWith(g.server.name + '-') ? e.label.slice(g.server.name.length + 1) : e.label;
      tb.append(h('tr', {},
        h('td', { class: 'nt-name' }, h('b', { title: e.label }, showName), h('div', { class: 'muted nt-sub' }, showName === pname ? null : pname, e.via ? h('span', { class: 'tag blue' }, '经 ' + serverName(e.via)) : null, e.cf ? h('span', { class: 'tag blue' }, 'CF') : null)),
        h('td', { class: 'mono nowrap nt-port', title: `${e.host}:${e.port}` }, e.host !== g.server.host ? h('div', { class: 'muted nt-host' }, e.host) : null, String(e.port)),
        row.cells.lat, row.cells.speed, row.cells.exit,
        h('td', { class: 'nt-link' }, h('span', { class: 'mono', title: '点击复制', onclick: () => copy(e.link) }, e.link)),
        h('td', { class: 'nowrap' }, h('div', { class: 'actions nowrap' },
          h('button', { class: 'small', onclick: () => copy(e.link) }, '复制'),
          h('button', { class: 'small', onclick: () => showQr(e.label, e.link) }, '二维码'),
          h('button', { class: 'small', title: '开一个经这个节点上网的浏览器窗口，看看网站能不能打开、显示的地区对不对', onclick: (ev) => busy(ev.currentTarget, () => api.call('node:browse', e)) }, '浏览器'),
          h('button', { class: 'small', onclick: (ev) => { const b = ev.currentTarget; menu(b, [e.cf ? null : { label: '改名', onClick: () => renameEntry(e) }, { label: '编辑', onClick: () => editEntry(e) }, { sep: true }, { label: '删除', danger: true, onClick: () => removeEntry(e, b) }]); } }, '更多 ▾')))));
    }
    const latBtn = h('button', { class: 'small' }, '一键测延迟');
    const spBtn = h('button', { class: 'small' }, '一键测速');
    latBtn.onclick = () => testMany(rows, ['lat'], latBtn, '测延迟');
    spBtn.onclick = () => testMany(rows, ['speed'], spBtn, '测速');
    const srv = S.servers.find((x) => x.id === g.server.id);
    v.append(h('div', { class: 'card nt-card' },
      h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, g.server.name), h('span', { class: 'muted mono' }, g.server.host), g.server.deployedAt ? null : h('span', { class: 'tag warn' }, '未部署'), h('span', { class: 'muted' }, `${g.entries.length} 个入口`), h('div', { class: 'spacer' }),
        g.entries.length ? h('div', { class: 'actions' },
          srv?.deployedAt ? h('button', { class: 'small', title: '一步步检查 SSH、服务、端口、是否被墙、节点真连', onclick: () => diagnoseServer(srv) }, '一键体检') : null,
          latBtn, spBtn,
          h('button', { class: 'small', onclick: () => copy(g.entries.map((e) => e.link).join('\n')) }, '复制全部')) : null),
      g.entries.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'nt-table' }, h('thead', {}, h('tr', {}, ['名称 / 协议', '端口', '延迟', '速度', '出口', '链接', ''].map((t) => h('th', {}, t)))), tb)) : h('div', { class: 'muted' }, '没有启用的协议')));
  }
  if (allRows.length) {
    const a = h('button', {}, '全部测延迟');
    const b = h('button', {}, '全部测出口');
    a.onclick = () => testMany(allRows, ['lat'], a, '测延迟');
    b.onclick = () => testMany(allRows, ['exit'], b, '测出口');
    a.className = 'primary';
    topBtns.append(b, a);
  }
}

async function renameEntry(e) {
  const inp = h('input', { value: e.custom || e.via ? e.label : '', placeholder: e.label, maxlength: 40 });
  modal({ title: '节点改名', body: h('div', {}, field('名称', inp, '订阅里显示的名字。留空恢复默认（服务器名-协议）。改完同步后用户刷新订阅生效')), buttons: [{ label: '取消' }, { label: '保存', class: 'primary', onClick: async () => {
    await api.call('node:rename', e, inp.value);
    const srvId = e.via || e.serverId;
    const srv = S.servers.find((x) => x.id === srvId);
    markDirty(); // 订阅内容在各台服务器上都有一份
    if (srv?.deployedAt) { toast('已改名，正在同步…'); try { await api.call('server:sync', srvId); toast('已改名。其它服务器上的订阅点「同步全部」后更新', 'ok'); } catch (err) { toast('已改名，同步失败：' + err.message, 'err'); } } else toast('已改名', 'ok');
    render();
  } }] });
}

// 节点页的「编辑」：普通入口打开服务器编辑并定位到这个协议；经中转的入口去「端口转发」改
function editEntry(e) {
  if (e.via) { go('forwards'); toast('经中转的入口在「端口转发」里修改'); return; }
  const s = S.servers.find((x) => x.id === e.serverId);
  if (!s) return;
  editServer(s, { focus: e.cf ? 'cf' : e.protocol });
}

// 节点页的「删除」：普通入口 = 在这台服务器上停用这个协议；经中转 = 删除那条转发；CF 优选入口 = 去掉这个优选地址。已部署的马上同步
async function removeEntry(e, btn) {
  const s = S.servers.find((x) => x.id === e.serverId);
  if (!s) return;
  const pname = PROTO_LABEL[e.protocol];
  let msg; let apply; let syncId = s.deployedAt ? s.id : null;
  if (e.via) {
    const f = (S.forwards || []).find((x) => x.relayServerId === e.via && Number(x.listenPort) === Number(e.port) && x.target?.serverId === s.id);
    if (!f) { toast('没找到这条转发，去「端口转发」里看看', 'err'); return; }
    const relay = S.servers.find((x) => x.id === e.via);
    msg = `删除经「${relay?.name || '中转'}」转发的 ${pname} 入口（${e.host}:${e.port}）？\n\n只删这条转发，${s.name} 上的 ${pname} 本身不受影响。`;
    apply = () => api.call('col:remove', 'forwards', f.id);
    syncId = relay?.deployedAt ? relay.id : null;
  } else if (e.cf) {
    const t = s.cfTunnel || {};
    const isMain = e.host === t.hostname;
    msg = isMain ? `关闭 ${s.name} 的 Cloudflare 隧道？\n\n隧道入口和所有优选地址入口都会去掉。` : `去掉 Cloudflare 优选地址 ${e.host}？`;
    apply = () => api.call('col:upsert', 'servers', { id: s.id, cfTunnel: isMain ? { ...t, enabled: false } : { ...t, cdnHosts: (t.cdnHosts || []).filter((x) => x !== e.host) } });
  } else {
    const left = Object.entries(s.protocols || {}).filter(([k, p]) => p?.enabled && k !== e.protocol).length;
    msg = `在 ${s.name} 上停用 ${pname}（端口 ${e.port}）？\n\n用户刷新订阅后就没有这个节点了。设置（端口、密码等）会保留，以后在「编辑」里重新勾选就能恢复。${left ? '' : '\n\n⚠ 这是这台服务器上最后一个协议，停用后这台就没有可用节点了。'}`;
    apply = () => api.call('col:upsert', 'servers', { id: s.id, protocols: { ...s.protocols, [e.protocol]: { ...s.protocols[e.protocol], enabled: false } } });
  }
  if (!(await confirmBox(msg, '删除'))) return;
  await busy(btn, async () => {
    await apply();
    if (syncId) {
      toast('已删除，正在同步到服务器…');
      try { await api.call('server:sync', syncId); toast('已删除并同步，用户刷新订阅即可', 'ok'); } catch (err) { markDirty(); toast('已删除，但同步失败：' + err.message + '\n稍后点「同步全部」', 'err'); }
    } else toast('已删除', 'ok');
    await render();
  }).catch((err) => toast('删除失败：' + err.message, 'err'));
}

// 节点 / 落地的测试结果：固定两行。第一行：延迟（或「不通」）+ IP 类型；第二行：出口 IP · 地区 · 运营商（太长省略，鼠标停留看全文）
function testResultView(cell, r) {
  cell.innerHTML = '';
  cell.classList.remove('muted');
  const box = h('div', { class: 'tr-box' });
  if (!r.ok) {
    const lines = String(r.error || '不通').split('\n').map((x) => x.trim()).filter(Boolean);
    const hint = lines.find((x) => x.startsWith('可能原因')) || '';
    const main = lines.filter((x) => x !== hint);
    const short = hint ? hint.replace(/^可能原因：/, '') : (main.length > 1 ? main[0] : '');
    const l2 = h('div', { class: 'tr-l2 muted' }, short);
    box.append(h('div', { class: 'tr-l1' }, h('span', { class: 'tag bad' }, '不通'), h('span', { class: 'tr-err' }, main[main.length - 1] || main[0] || '')), l2);
    box.title = '点击展开 / 收起完整报错';
    box.classList.add('tr-fold');
    box.onclick = () => { const open = box.classList.toggle('tr-open'); l2.textContent = open ? lines.join('\n') : short; };
  } else {
    const ip = r.ip;
    const lat = Number(r.latency) || 0;
    box.append(h('div', { class: 'tr-l1' }, h('span', { class: 'tag ' + (lat > 1500 ? 'warn' : 'ok') }, `${lat} ms`),
      ip ? h('span', { class: 'tag ' + (ip.hosting ? 'warn' : 'ok') }, ip.hosting ? '机房 IP' : '住宅 / 非机房') : null));
    if (ip) {
      const where = [ip.country, ip.city].filter(Boolean).join(' ');
      const full = [ip.query, where, ip.isp].filter(Boolean).join(' · ');
      box.append(h('div', { class: 'tr-l2', title: full }, h('span', { class: 'mono' }, ip.query), where ? ` · ${where}` : '', ip.isp ? h('span', { class: 'muted' }, ` · ${ip.isp}`) : null));
    }
  }
  cell.append(box);
}

async function testEntry(e, cell) {
  cell.textContent = '测试中…';
  testResultView(cell, await api.call('node:test', e, 'owner'));
}

async function showQr(title, text, hint) {
  const src = await api.call('qr', text);
  modal({ title, body: h('div', { style: { textAlign: 'center' } }, h('img', { class: 'qr qr-big', src }), h('p', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '12px' } }, text), h('p', { class: 'muted', style: { fontSize: '12px' } }, hint || '扫不出来时：点「复制」，在手机 v2rayNG 右上角「+」里选「从剪贴板导入」。请用较新版 v2rayNG/ NekoBox / Clash Meta / Hiddify；Hysteria2、TUIC 太旧的客户端会导入失败或被过滤')), buttons: [{ label: '复制', onClick: () => copy(text) }, { label: '关闭' }] });
}
