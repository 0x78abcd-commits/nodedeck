'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → … → toolbox.js → stock.js → settings.js（最后一个启动界面）

// ---------- 补货提醒 ----------
// 两种方式：内置（轻量，agent 按文字规则检查）和 changedetection.io（Docker 一键装，能看 JavaScript 页面）
const STOCK_INTERVALS = [[30, '30 秒'], [60, '1 分钟'], [120, '2 分钟'], [300, '5 分钟'], [600, '10 分钟'], [1800, '30 分钟']];
const STOCK_HINT = {
  gone: '页面上这段文字消失就算有货。WHMCS 这类 VPS 商家缺货时一般写 Out of Stock、缺货、已售罄、Sold Out',
  appear: '页面上出现这段文字就算有货，例如 Order Now、立即购买、加入购物车',
  regex: '正则能在页面文字里匹配到就算有货（不区分大小写可以写 (?i)）',
};
function agoText(sec) {
  if (!sec) return '';
  const d = Math.max(0, Date.now() / 1000 - sec);
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  return Math.floor(d / 86400) + ' 天前';
}

async function viewStock(v) {
  await reload();
  const info = await api.call('stock:info');
  const deployed = S.servers.filter((x) => x.deployedAt);
  const builtinOn = (info.watches || []).length > 0 || !!info.serverId;
  const cdOn = !!info.cd?.serverId;
  v.append(h('h1', {}, '补货提醒'), h('p', { class: 'sub' }, '盯着商品页，补货了就发通知（Telegram / 微信）'));
  if (!deployed.length) { v.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, '先部署一台服务器：检查商品页、装 changedetection.io 都在你的 VPS 上进行。'))); return; }
  if (!info.notifyOn) v.append(h('div', { class: 'card', style: { borderColor: 'var(--warn)' } }, h('b', {}, '还没配通知渠道'), h('p', { class: 'muted', style: { margin: '4px 0 0' } }, '补货消息要发到 Telegram 或微信，先在「设置 → 通知」里填好一个（微信用 PushPlus 最省事）。'), h('button', { class: 'small', onclick: () => go('settings') }, '去设置')));
  if (!builtinOn && !cdOn) { v.append(stockChooser(deployed)); return; }
  if (builtinOn) v.append(stockBuiltinCard(info, deployed));
  if (cdOn) v.append(await stockCdCard(info));
  if (!builtinOn || !cdOn) v.append(h('p', { class: 'muted' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); stockChooserModal(deployed, { builtinOn, cdOn }); } }, builtinOn ? '还想盯淘宝 / 京东这类复杂页面？一键装 changedetection.io' : '只盯几个简单页面？用内置提醒（不用装东西）')));
}

function stockOptionCards(deployed, { onBuiltin, onCd, builtinOn, cdOn }) {
  const opt = (title, tag, lines, btn, on, done) => h('div', { class: 'card', style: { flex: '1 1 300px', margin: 0, display: 'flex', flexDirection: 'column' } },
    h('h3', {}, title, ' ', h('span', { class: 'tag ' + (tag === '推荐' ? 'ok' : 'blue') }, tag)),
    lines.map((l) => h('p', { class: 'muted', style: { margin: '6px 0' } }, l)),
    h('div', { style: { marginTop: 'auto', paddingTop: '6px' } }, done ? h('span', { class: 'tag ok' }, '已在用') : h('button', { class: 'primary', onclick: on }, btn)));
  return h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '12px', alignItems: 'stretch' } },
    opt('内置提醒', '推荐', ['不用装任何东西：选一台服务器，它每隔一会儿打开商品页，按你给的文字判断有没有货。', '适合 VPS 商家库存页（WHMCS 等）这类普通网页，几乎不占资源。', '看不了要跑 JavaScript 才显示内容的页面，也过不了 Cloudflare 人机验证。'], '用内置提醒', onBuiltin, builtinOn),
    opt('changedetection.io', '开源 · 功能全', ['在一台服务器上用 Docker 一键装这个开源的网页监控工具，有专门的「补货和价格检测」模式，还能设价格阈值。', '可选带 Chrome 浏览器，能看淘宝、京东、亚马逊这类要跑 JavaScript 的页面（多占约 500MB 内存）。', '只在 VPS 本机监听，NodeDeck 经 SSH 隧道打开它的管理界面，不对外开端口。'], '一键安装', onCd, cdOn));
}

function stockChooser(deployed) {
  return h('div', {}, h('p', {}, '有两种方式，选一种开始（以后也可以两种都用）：'),
    stockOptionCards(deployed, { onBuiltin: () => stockEditWatch(null), onCd: () => cdInstallModal(deployed) }));
}

function stockChooserModal(deployed, state) {
  const m = modal({ title: '选择补货提醒方式', wide: true, body: stockOptionCards(deployed, { ...state, onBuiltin: () => { m.close(); stockEditWatch(null); }, onCd: () => { m.close(); cdInstallModal(deployed); } }), buttons: [{ label: '关闭' }] });
}

// 内置提醒
function stockBuiltinCard(info, deployed) {
  const card = h('div', { class: 'card' });
  const srvSel = h('select', { class: 'auto' }, deployed.map((x) => h('option', { value: x.id }, x.name)));
  srvSel.value = info.serverId || deployed[0].id;
  srvSel.onchange = async () => {
    if (!(await confirmBox(`改成由「${srvSel.selectedOptions[0].textContent}」来检查？会同步原来那台和这台服务器。`))) { srvSel.value = info.serverId; return; }
    srvSel.disabled = true;
    try { await stockSave(info.watches, srvSel.value); } catch (e) { toast(e.message, 'err'); srvSel.disabled = false; }
  };
  const rows = (info.watches || []).map((w) => {
    const st = info.status?.[w.id];
    let state;
    if (!w.enabled) state = h('span', { class: 'tag' }, '已暂停');
    else if (!st) state = h('span', { class: 'tag' }, info.agentOld ? '要先同步升级 agent' : '等第一次检查');
    else if (st.error && !st.inStock) state = h('span', { class: 'tag warn', title: st.error }, '出错：' + st.error.slice(0, 24));
    else state = h('span', { class: 'tag ' + (st.inStock ? 'ok' : '') }, st.inStock ? '有货' : '缺货');
    return h('tr', {},
      h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.call('open:external', w.url); } }, w.name), h('div', { class: 'muted', style: { fontSize: '12px', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w.url)),
      h('td', { style: { fontSize: '12px' } }, info.modes[w.mode] + '：', h('b', {}, w.text)),
      h('td', { class: 'muted', style: { fontSize: '12px' } }, '每 ' + (STOCK_INTERVALS.find(([s]) => s === w.interval)?.[1] || w.interval + ' 秒')),
      h('td', {}, state, st?.lastCheck ? h('div', { class: 'muted', style: { fontSize: '12px' } }, '检查于 ' + agoText(st.lastCheck) + (st.lastChange ? ' · 状态变于 ' + agoText(st.lastChange) : '')) : null),
      h('td', { class: 'actions' },
        h('button', { class: 'small', onclick: () => stockEditWatch(w) }, '编辑'),
        h('button', { class: 'small', onclick: (e) => busy(e.currentTarget, () => stockSave(info.watches.map((x) => x.id === w.id ? { ...x, enabled: !x.enabled } : x), srvSel.value)) }, w.enabled ? '暂停' : '启用'),
        h('button', { class: 'small danger', onclick: async (e) => { const b = e.currentTarget; if (await confirmBox(`删除「${w.name}」的监控？`)) busy(b, () => stockSave(info.watches.filter((x) => x.id !== w.id), srvSel.value)); } }, '删除')));
  });
  card.append(h('h3', {}, '内置提醒'),
    h('div', { class: 'row', style: { alignItems: 'center' } }, h('span', { class: 'muted' }, '由这台服务器检查（用它的 IP 打开商品页）：'), srvSel,
      h('button', { class: 'small auto', onclick: (e) => busy(e.currentTarget, async () => { await api.call('stock:refresh'); render(); }) }, '刷新状态'),
      h('button', { class: 'small primary auto', onclick: () => stockEditWatch(null) }, '+ 添加商品')),
    rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['商品', '判断规则', '间隔', '状态', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))
      : h('p', { class: 'muted' }, '还没有要盯的商品，点「添加商品」。'),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, '补货、又卖完时各发一条通知；第一次检查就有货也会发一条。打不开或被拦时只记错误，不会误报补货。'));
  return card;
}

async function stockSave(watches, serverId) {
  const r = await api.call('stock:save', { serverId, watches });
  const bad = r.results.filter((x) => !x.ok);
  if (bad.length) toast('已保存，但同步失败：' + bad.map((x) => `${x.name}（${x.error}）`).join('；'), 'err');
  else toast('已保存并同步到服务器', 'ok');
  render();
}

async function stockEditWatch(orig) {
  const info = await api.call('stock:info');
  const deployed = S.servers.filter((x) => x.deployedAt);
  const w = orig || await api.call('stock:newWatch');
  const name = h('input', { value: w.name || '', placeholder: '例如 某商家 2C2G 年付' });
  const url = h('input', { value: w.url || '', placeholder: 'https://…（商品页或库存页地址）' });
  const mode = h('select', {}, Object.entries(info.modes).map(([k, l]) => h('option', { value: k }, l)));
  mode.value = w.mode || 'gone';
  const text = h('input', { value: w.text || '' });
  const hint = h('small', { class: 'muted' });
  const syncHint = () => { hint.textContent = STOCK_HINT[mode.value]; text.placeholder = { gone: 'Out of Stock', appear: 'Order Now', regex: '(?i)(order now|立即购买)' }[mode.value]; };
  mode.onchange = syncHint; syncHint();
  const iv = h('select', {}, STOCK_INTERVALS.map(([s, l]) => h('option', { value: s }, l)));
  iv.value = String(w.interval || 120);
  const srv = h('select', {}, deployed.map((x) => h('option', { value: x.id }, x.name)));
  srv.value = info.serverId || deployed[0]?.id || '';
  const out = h('div', {});
  const collect = () => ({ ...w, name: name.value.trim(), url: url.value.trim(), mode: mode.value, text: text.value.trim(), interval: Number(iv.value) });
  const body = h('div', {},
    field('名称', name), field('商品页地址', url),
    h('div', { class: 'row' }, field('判断规则', mode), field('文字', text)), hint,
    h('div', { class: 'row', style: { marginTop: '8px' } }, field('多久查一次', iv, '太频繁可能被商家拦，一般 1–2 分钟就够'), info.serverId ? null : field('由哪台服务器检查', srv)),
    h('div', { class: 'actions' }, h('button', { onclick: (e) => busy(e.currentTarget, async () => {
      out.innerHTML = '';
      const r = await api.call('stock:test', info.serverId || srv.value, collect());
      out.append(h('div', { class: 'card', style: { margin: '8px 0 0' } },
        r.title ? h('div', {}, '页面标题：', h('b', {}, r.title)) : null,
        h('div', { class: 'muted', style: { fontSize: '12px' } }, `HTTP ${r.status || '—'} · ${fmtBytes(r.bytes)}`),
        r.error ? h('p', { style: { color: 'var(--bad)' } }, r.error)
          : h('p', {}, '按现在的规则判断：', h('span', { class: 'tag ' + (r.inStock ? 'ok' : '') }, r.inStock ? '有货' : '缺货'),
            r.snippet ? h('div', { class: 'muted mono', style: { fontSize: '12px', marginTop: '4px', wordBreak: 'break-all' } }, '找到：…' + r.snippet + '…') : h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, '页面上没找到这段文字')),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, '判断和当前页面实际情况对不上的话，换一段文字或换规则再试。')));
    }) }, '测试一下（在服务器上打开一次）')), out);
  modal({ title: orig ? '编辑商品监控' : '添加商品监控', wide: true, body, buttons: [{ label: '取消' }, { label: '保存', class: 'primary', onClick: async () => {
    const nw = collect();
    const list = orig ? info.watches.map((x) => x.id === orig.id ? nw : x) : [...(info.watches || []), nw];
    await stockSave(list, info.serverId || srv.value);
  } }] });
}

// changedetection.io
function cdInstallModal(deployed, preset) {
  const srv = h('select', {}, deployed.map((x) => h('option', { value: x.id }, `${x.name}${x.hw?.memMB ? `（${x.hw.memMB >= 1024 ? (x.hw.memMB / 1024).toFixed(0) + 'G' : x.hw.memMB + 'M'} 内存）` : ''}`)));
  srv.value = preset || deployed.slice().sort((a, b) => (b.hw?.memMB || 0) - (a.hw?.memMB || 0))[0].id;
  const browser = h('input', { type: 'checkbox' });
  const memNote = h('small', { class: 'muted' });
  const syncNote = () => { const m = S.servers.find((x) => x.id === srv.value)?.hw?.memMB || 0; memNote.textContent = browser.checked ? (m && m < 1500 ? `⚠ 这台只有 ${m}MB 内存，带浏览器可能不够（建议 2G 以上）` : '浏览器平时只占几十 MB，打开页面时每个约 200–500MB；同时只开 1 个页面，最多用到 800MB') : '精简模式：实测约 100MB 内存（限制最多 320MB，超了自动重启）'; };
  srv.onchange = syncNote; browser.onchange = syncNote; syncNote();
  const logBox = h('pre', { class: 'term hidden', style: { maxHeight: '220px' } });
  const body = h('div', {},
    h('p', { class: 'muted' }, '在选中的服务器上用 Docker 装 changedetection.io（没有 Docker 会先自动装）。它只在 VPS 本机监听，装好后点「打开管理界面」，NodeDeck 会经 SSH 隧道打开，不对外开放端口。'),
    field('装在哪台服务器', srv),
    h('label', { class: 'f' }, browser, ' 带 Chrome 浏览器（要看淘宝 / 京东 / 亚马逊这类 JavaScript 页面时勾上）'), memNote, logBox);
  let off = null;
  modal({ title: '一键安装 changedetection.io', wide: true, body, onClose: () => off && off(), buttons: [{ label: '取消' }, { label: '安装', class: 'primary', close: false, onClick: async (close) => {
    logBox.classList.remove('hidden'); logBox.textContent = '';
    off = api.on('task-log', (m) => { if (m.task !== 'cd:' + srv.value) return; logBox.textContent += m.line + '\n'; logBox.scrollTop = logBox.scrollHeight; });
    try {
      await api.call('cd:install', srv.value, { browser: browser.checked });
      toast('changedetection.io 装好了，点「打开管理界面」开始添加商品', 'ok');
      close(); render();
    } finally { off(); off = null; }
  } }] });
}

async function stockCdCard(info) {
  const cd = info.cd;
  const srv = S.servers.find((x) => x.id === cd.serverId);
  const card = h('div', { class: 'card' }, h('h3', {}, 'changedetection.io'));
  if (!srv) { card.append(h('p', { class: 'muted' }, '装它的那台服务器已经删掉了。'), h('button', { onclick: () => cdInstallModal(S.servers.filter((x) => x.deployedAt)) }, '重新安装')); return card; }
  const stLine = h('span', { class: 'muted' }, '读取状态中…');
  const showStatus = (st) => {
    stLine.replaceChildren(!st.installed ? h('span', { class: 'tag warn' }, '没装（可能被删了）') : h('span', { class: 'tag ' + (st.running ? 'ok' : 'warn') }, st.running ? '运行中' : '没在运行：' + st.state),
      st.installed ? ` 装在 ${srv.name}${st.browser ? ' · 带浏览器' + (st.browserRunning ? '' : '（浏览器没在运行）') : ''}${st.mem ? ' · 内存 ' + st.mem.split(';').filter(Boolean).map((x) => x.split('/')[0].trim()).join(' + ') : ''}` : '',
      st.installed && !st.lean ? h('span', {}, ' ', h('button', { class: 'small', title: '少开并发、关掉详细日志和 AI 功能、限制内存上限；监控列表和历史都保留', onclick: (e) => busy(e.currentTarget, async () => { showStatus(await api.call('cd:install', srv.id, { browser: st.browser })); toast('已改成精简模式，数据都在', 'ok'); }) }, '改成精简模式（省内存）')) : '');
  };
  api.call('cd:status', srv.id).then(showStatus).catch((e) => stLine.replaceChildren(h('span', { class: 'tag warn' }, '读不到状态'), ' ', e.message));
  card.append(h('div', {}, stLine),
    h('div', { class: 'actions', style: { marginTop: '10px' } },
      h('button', { class: 'primary', onclick: (e) => busy(e.currentTarget, async () => { const p = await api.call('cd:open', srv.id); toast(`已在浏览器打开（经 SSH 隧道，本机 127.0.0.1:${p}；NodeDeck 开着时一直可用）`, 'ok'); }) }, '打开管理界面'),
      h('button', { onclick: (e) => busy(e.currentTarget, async () => showStatus(await api.call('cd:status', srv.id))) }, '刷新状态'),
      h('button', { onclick: () => cdInstallModal(S.servers.filter((x) => x.deployedAt), srv.id) }, '重新安装 / 换配置'),
      h('button', { class: 'danger', onclick: async (e) => {
        const b = e.currentTarget;
        const keep = h('input', { type: 'checkbox', checked: true });
        const ok = await new Promise((resolve) => modal({ title: '卸载 changedetection.io', body: h('div', {}, h('p', {}, `从 ${srv.name} 上删除 changedetection.io 的容器${cd.browser ? '和浏览器' : ''}。`), h('label', { class: 'f' }, keep, ' 保留数据（监控列表和历史），以后重装还能接着用')), onClose: () => resolve(false), buttons: [{ label: '取消', onClick: () => resolve(false) }, { label: '卸载', class: 'danger', onClick: () => resolve(true) }] }));
        if (ok) busy(b, async () => { await api.call('cd:uninstall', srv.id, { keepData: keep.checked }); toast('已卸载', 'ok'); render(); });
      } }, '卸载')),
    h('div', { style: { marginTop: '12px' } },
      h('b', {}, '收通知'),
      info.notifyUrls.length
        ? h('div', {}, h('p', { class: 'muted', style: { margin: '4px 0' } }, '在 changedetection.io 的「SETTINGS → Notifications」里粘贴下面的地址（Apprise 格式，含你的密钥，别发给别人；要多个渠道就一行一个都贴上）：'),
          ...info.notifyUrls.map((u) => h('div', { class: 'row', style: { alignItems: 'center' } }, h('span', { class: 'muted', style: { flex: '0 0 72px' } }, u.label), h('input', { value: u.url, readonly: true, class: 'mono' }), h('button', { class: 'auto', onclick: () => copy(u.url) }, '复制'))),
          info.notifyUrls.length > 1 ? h('button', { class: 'small', onclick: () => copy(info.notifyUrls.map((u) => u.url).join('\n')) }, '全部复制') : null)
        : h('p', { class: 'muted', style: { margin: '4px 0' } }, '先在「设置 → 通知」里填好 Telegram 或微信（PushPlus / Server 酱），这里会给出可以直接粘贴的通知地址。'),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, '添加商品时，Processor 选「Re-stock & Price detection」就是补货检测，还能设价格低于多少时提醒；要看 JavaScript 页面，Fetch method 选 Chrome（安装时勾了浏览器才有）。')));
  return card;
}
