'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

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
  const filter = h('select', { style: { maxWidth: '140px' } }, [['all', '全部'], ['ok', '正常'], ['bad', '停用/到期/用尽'], ['warn', '即将到期'], ['online', '在用'], ['multi', '多台在用']].map(([k, l]) => h('option', { value: k }, l)));
  filter.value = userView.filter;
  filter.onchange = () => { userView.filter = filter.value; userView.page = 1; render(); };

  const q = userView.q.trim().toLowerCase();
  const online = (u) => u.lastActive && Date.now() - u.lastActive < 15 * 60 * 1000;
  // 在用：有设备统计时显示几台（最近 10 分钟连过的不同来源 IP，各服务器合并），没有就只看最近有没有流量
  const devs = (u) => (u.online && Date.now() - u.online.at < 15 * 60 * 1000 ? u.online.ips : null);
  const onlineCell = (u) => {
    const ips = devs(u);
    if (ips && ips.length) return h('span', { class: 'tag ok', title: `最近 10 分钟连过的 IP：\n${ips.join('\n')}\n\n按来源 IP 算：同一个 Wi-Fi 下的几台设备算 1 台，手机切换网络时可能多算 1 台` }, `${ips.length} 台在用`);
    if (online(u)) return h('span', { class: 'tag ok' }, '在用');
    return h('span', { class: 'muted' }, u.lastActive ? ago(u.lastActive) : '从未使用');
  };
  let list = S.users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.note || '').toLowerCase().includes(q));
  if (userView.filter === 'online') list = list.filter((u) => online(u) || (devs(u) || []).length);
  else if (userView.filter === 'multi') list = list.filter((u) => (devs(u) || []).length > 1);
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
      h('td', {}, onlineCell(u)),
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

// 防 DNS / WebRTC 泄露说明（订阅信息页里也有一份给用户看）
function leakGuide() {
  const sec = (title, ...lines) => h('div', { style: { marginBottom: '12px' } }, h('b', {}, title), lines.map((l) => h('p', { class: 'muted', style: { margin: '4px 0 0' } }, l)));
  modal({ title: '防止 DNS / 真实 IP 泄露', wide: true, body: h('div', {},
    h('p', {}, 'DNS 泄露：本地运营商的 DNS 能看到你访问了哪些国外网站。WebRTC 泄露：浏览器用 UDP 直接问外部服务器「我的公网 IP」，只开系统代理时这个请求不走代理，网页就能拿到你的真实 IP。服务器这边管不了，要靠客户端设置；NodeDeck 生成的 sing-box 和 Clash 订阅已经配好了 DNS。'),
    sec('最省事的办法', '客户端打开「TUN / VPN 模式」（v2rayNG、sing-box、Hiddify 默认就是）：所有流量包括浏览器的 WebRTC 和 DNS 都走代理。'),
    sec('Clash Verge / FlClash / Clash Meta', '订阅里已配好：fake-ip，国外域名经节点用加密 DNS（1.1.1.1）查，国内域名用国内加密 DNS（223.5.5.5）查，按 IP 分流时不在本地解析。', '不要打开客户端的「DNS 覆写」（打开后以客户端的设置为准）。要防 WebRTC 就打开「虚拟网卡 / TUN 模式」。'),
    sec('sing-box（SFA / SFI / SFM）', '订阅里已配好 TUN 和 DNS（国外经节点用 1.1.1.1，国内用 223.5.5.5），打开 VPN 即可。'),
    sec('v2rayNG', '分享链接带不了 DNS 设置，要在客户端里配：设置里「远程 DNS」填 https://1.1.1.1/dns-query，「国内 DNS」填 223.5.5.5，打开「启用本地 DNS」；路由选「绕过局域网及大陆地址」。'),
    sec('v2rayN', '系统代理模式下浏览器的 WebRTC 不走代理，要防就打开 TUN 模式。'),
    sec('浏览器补一道', 'Chrome：装 uBlock Origin，在它的设置里勾「防止 WebRTC 泄露本地 IP 地址」。Firefox：about:config 里把 media.peerconnection.enabled 改成 false（网页视频通话会用不了）。'),
    sec('自查', '连上节点后打开 ipleak.net：显示的 IP 和 DNS 服务器都应该在节点所在的国家，不应出现你本地运营商。'),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, '用户在浏览器里打开自己的订阅地址，也能看到这份说明（「防止 DNS / 真实 IP 泄露」一栏）。')),
  buttons: [{ label: '打开 ipleak.net', onClick: () => api.call('open:external', 'https://ipleak.net/') }, { label: '关闭' }] });
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
    if (r.https) body.append(r.https.ok
      ? h('p', { class: 'muted', style: { fontSize: '12px' } }, h('span', { class: 'tag ok' }, 'HTTPS'), ' 订阅内容加密传输（Let\'s Encrypt 给 IP 签的证书，每 6 天自动续）。以前发出去的 http:// 地址也还能用，建议让用户换成上面的新地址')
      : h('p', { class: 'muted', style: { fontSize: '12px' } }, h('span', { class: 'tag warn' }, '还是 HTTP'), ' ', r.https.error ? `${r.https.server} 的订阅证书没申请下来：${r.https.error}` : '订阅证书还没申请（点「同步」后一两分钟内自动申请，申请好地址会自动变成 https://）'));
    if (r.backups.length) body.append(h('h4', {}, '备用订阅地址（主地址打不开时用）'), ...r.backups.map((b) => row(b.server, b.url)));
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
  modal({ title: `${u.name} 的订阅`, wide: true, body, buttons: [{ label: '防泄露设置', close: false, onClick: () => leakGuide() }, { label: '复制全部链接', onClick: () => copy(r.links.join('\n')) }, { label: '关闭' }] });
}
