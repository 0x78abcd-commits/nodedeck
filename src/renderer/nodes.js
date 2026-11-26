'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

// ---------- 节点 ----------
// 测试结果按入口记住（切页面、重启软件都还在，存在本机浏览器存储里）
const nodeKey = (e) => [e.serverId, e.protocol, e.host, e.port, e.via || ''].join('|');
let NODE_RES = {};
try { NODE_RES = JSON.parse(localStorage.getItem('nodeResults') || '{}'); } catch (_) { NODE_RES = {}; }
const saveNodeRes = () => { try { localStorage.setItem('nodeResults', JSON.stringify(NODE_RES)); } catch (_) { /* 存不了就算了 */ } };

// 测一个入口：withSpeed = 顺便经节点下载测速
async function runEntryTest(e, cell, withSpeed) {
  cell.textContent = withSpeed ? '测速中…' : '测试中…';
  const r = await api.call('node:test', e, 'owner', { latency: true, exit: true, speed: !!withSpeed });
  // 只测延迟时保留上次的测速结果
  const old = NODE_RES[nodeKey(e)];
  if (!withSpeed && r.ok && old?.ok && old.speed) r.speed = old.speed;
  NODE_RES[nodeKey(e)] = r; saveNodeRes();
  testResultView(cell, r);
  return r;
}

// 一组入口一起测：测延迟最多 4 个同时测，测速一个一个来（同时测会互相抢带宽）
async function testMany(rows, withSpeed, btn, label) {
  const old = btn.textContent;
  btn.disabled = true;
  try {
    let done = 0;
    const tick = () => { btn.textContent = `${label} ${done}/${rows.length}`; };
    tick();
    const queue = rows.slice();
    await Promise.all(Array.from({ length: Math.min(withSpeed ? 1 : 4, queue.length) }, async () => {
      while (queue.length) { const r = queue.shift(); try { await runEntryTest(r.e, r.cell, withSpeed); } catch (_) { /* 单个失败不影响其它 */ } done++; tick(); }
    }));
  } finally { btn.textContent = old; btn.disabled = false; }
}

async function viewNodes(v) {
  await reload();
  v.append(h('h1', {}, '节点'), h('p', { class: 'sub' }, '这里显示的是默认用户的链接（自用）。给别人用请在「用户」里创建并发订阅。'));
  const groups = await api.call('nodes:list');
  if (!groups.length) { v.append(emptyState('还没有节点', '节点在服务器部署好之后自动生成。', h('button', { class: 'primary', onclick: () => go('servers') }, '去添加服务器'))); return; }
  for (const g of groups) {
    const tb = h('tbody');
    const rows = [];
    for (const e of g.entries) {
      const res = h('td', { class: 'muted' }, '—');
      const last = NODE_RES[nodeKey(e)];
      if (last) testResultView(res, last);
      rows.push({ e, cell: res });
      tb.append(h('tr', {},
        h('td', { class: 'nowrap' }, h('b', {}, e.custom ? e.label : PROTO_LABEL[e.protocol]), e.custom ? h('div', { class: 'muted', style: { fontSize: '12px' } }, PROTO_LABEL[e.protocol]) : null, e.via ? h('div', {}, h('span', { class: 'tag blue' }, '经 ' + serverName(e.via))) : null),
        h('td', { class: 'mono nowrap', style: { fontSize: '12.5px' } }, `${e.host}:${e.port}`),
        res,
        h('td', { class: 'nowrap' }, h('div', { class: 'actions nowrap' },
          h('button', { class: 'small', onclick: () => copy(e.link) }, '复制'),
          h('button', { class: 'small', onclick: () => showQr(e.label, e.link) }, '二维码'),
          h('button', { class: 'small primary', onclick: (ev) => busy(ev.currentTarget, () => runEntryTest(e, res, false)) }, '测试'),
          h('button', { class: 'small', onclick: (ev) => { const b = ev.currentTarget; menu(b, [e.cf ? null : { label: '改名', onClick: () => renameEntry(e) }, { label: '编辑', onClick: () => editEntry(e) }, { sep: true }, { label: '删除', danger: true, onClick: () => removeEntry(e, b) }]); } }, '更多 ▾')))));
    }
    const latBtn = h('button', { class: 'small', title: '这台的所有入口测延迟和出口 IP（最多 4 个同时测）' }, '一键测延迟');
    const spBtn = h('button', { class: 'small', title: '这台的所有入口经节点下载测速，一个一个测（每个约 10 秒）' }, '一键测速');
    latBtn.onclick = () => testMany(rows, false, latBtn, '测延迟');
    spBtn.onclick = () => testMany(rows, true, spBtn, '测速');
    const srv = S.servers.find((x) => x.id === g.server.id);
    v.append(h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, g.server.name), h('span', { class: 'muted mono' }, g.server.host), g.server.deployedAt ? null : h('span', { class: 'tag warn' }, '未部署'), h('div', { class: 'spacer' }),
        srv?.deployedAt && g.entries.length ? h('button', { class: 'small', title: '一步步检查 SSH、服务、端口、是否被墙、节点真连', onclick: () => diagnoseServer(srv) }, '一键体检') : null,
        g.entries.length ? latBtn : null, g.entries.length ? spBtn : null,
        h('button', { class: 'small', onclick: () => copy(g.entries.map((e) => e.link).join('\n')) }, '复制全部')),
      g.entries.length ? h('table', {}, h('thead', {}, h('tr', {}, ['协议', '入口', '测试结果', '操作'].map((t) => h('th', {}, t)))), tb) : h('div', { class: 'muted' }, '没有启用的协议')));
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

// 节点页的「编辑」：普通入口打开服务器编辑并定位到这个协议；经中转的入口去「中转」改
function editEntry(e) {
  if (e.via) { go('relays'); toast('经中转的入口在「中转」里修改'); return; }
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
    if (!f) { toast('没找到这条转发，去「中转」里看看', 'err'); return; }
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
      ip && !ip.self ? h('span', { class: 'tag ' + (ip.hosting ? 'warn' : 'ok') }, ip.hosting ? '机房 IP' : '住宅 / 非机房') : null,
      r.speed ? (r.speed.error ? h('span', { class: 'tag bad', title: r.speed.error }, '测速失败') : h('span', { class: 'tag blue', title: '经节点下载测速' + (r.speed.source ? '，来源 ' + r.speed.source : '') }, `${r.speed.mbps >= 100 ? r.speed.mbps.toFixed(0) : r.speed.mbps.toFixed(1)} Mbps`)) : null));
    if (ip?.self) { // 新版：出口 IP 由节点所在 VPS 自己报，不经第三方
      box.append(h('div', { class: 'tr-l2', title: '节点的出口 IP，由节点所在的 VPS 自己查（不经第三方）' }, h('span', { class: 'muted' }, '出口 '), h('span', { class: 'mono' }, ip.query), ip.landing ? h('span', { class: 'muted' }, `（经落地「${ip.landing}」）`) : null));
    } else if (r.ipError) {
      box.append(h('div', { class: 'tr-l2 muted', title: r.ipError }, '出口 IP 查不到：' + r.ipError));
    } else if (ip) {
      const where = [ip.country, ip.city].filter(Boolean).join(' ');
      const full = [ip.query, where, ip.isp].filter(Boolean).join(' · ');
      box.append(h('div', { class: 'tr-l2', title: full }, h('span', { class: 'mono' }, ip.query), where ? ` · ${where}` : '', ip.isp ? h('span', { class: 'muted' }, ` · ${ip.isp}`) : null));
    }
  }
  cell.append(box);
}

async function showQr(title, text, hint) {
  const src = await api.call('qr', text);
  modal({ title, body: h('div', { style: { textAlign: 'center' } }, h('img', { class: 'qr qr-big', src }), h('p', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '12px' } }, text), h('p', { class: 'muted', style: { fontSize: '12px' } }, hint || '扫不出来时：点「复制」，在手机 v2rayNG 右上角「+」里选「从剪贴板导入」。请用较新版 v2rayNG/ NekoBox / Clash Meta / Hiddify；Hysteria2、TUIC 太旧的客户端会导入失败或被过滤')), buttons: [{ label: '复制', onClick: () => copy(text) }, { label: '关闭' }] });
}
