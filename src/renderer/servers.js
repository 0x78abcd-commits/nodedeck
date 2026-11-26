'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

// ---------- 服务器 ----------
function agentOutdated(s) {
  const v = s.lastStatus?.agentVersion;
  return !!(s.deployedAt && v && info.packaged && v !== info.version);
}

async function viewServers(v) {
  await reload();
  v.append(h('div', { class: 'toolbar' }, h('div', {}, h('h1', {}, '服务器'), h('p', { class: 'sub' }, '通过 SSH 安装 sing-box 和 agent，一键部署 9 种协议（XHTTP 两种由 Xray 提供）')), h('div', { class: 'spacer' }),
    h('button', { onclick: (e) => busy(e.currentTarget, syncAll) }, '同步全部'),
    h('button', { class: 'primary', onclick: () => editServer() }, '+ 添加服务器')));
  if (!S.servers.length) { v.append(emptyState('还没有服务器', '填 VPS 的 IP 和 SSH 密码，NodeDeck 会一键装好代理内核和 agent，生成节点和订阅。', h('button', { class: 'primary', onclick: () => editServer() }, '+ 添加服务器'))); return; }
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
    const realityTag = core_reality(s) && rs?.fails > 0 ? h('span', { class: 'tag warn', title: rs.lastErr || '' }, `Reality 目标异常 ×${rs.fails}`) : null;
    const st = s.lastStatus;
    const status = !s.deployedAt ? h('span', { class: 'tag' }, '未部署') : st && st.singbox && st.agent ? h('span', { class: 'tag ok' }, '运行中') : h('span', { class: 'tag bad' }, '异常');
    // 协议 / 端口：竖着一行一个，名称左、端口右，前面的小点区分 TCP / UDP
    const NETS = { vlessReality: 'tcp', trojan: 'tcp', vmess: 'tcp', anytls: 'tcp', hysteria2: 'udp', tuic: 'udp', shadowsocks: 'both', vlessXhttpReality: 'tcp', vlessXhttpTls: 'tcp' };
    const protos = PROTOS.filter(([k]) => s.protocols?.[k]?.enabled).map(([k, l]) => h('div', { class: 'pl-row', title: { tcp: 'TCP', udp: 'UDP', both: 'TCP + UDP' }[NETS[k]] },
      h('i', { class: 'pl-dot ' + NETS[k] }), h('span', { class: 'pl-name' }, l), h('span', { class: 'pl-port mono' }, s.protocols[k].port)));
    const exit = s.exit?.type === 'landing' ? h('span', { class: 'tag blue' }, '落地: ' + (S.landings.find((l) => l.id === s.exit.landingId)?.name || '?')) : h('span', { class: 'tag' }, '直连');
    const fw = S.forwards.filter((f) => f.relayServerId === s.id).length;
    const lamp = !s.deployedAt ? 'idle' : st && st.singbox && st.agent ? 'ok' : 'bad';
    tb.append(h('tr', { class: 'lamp-' + lamp },
      h('td', { style: { width: '28px' } }, cb),
      h('td', {}, h('div', { class: 'srv-name' }, s.name), h('div', { class: 'muted mono', style: { wordBreak: 'normal', whiteSpace: 'nowrap', fontSize: '12px' } }, s.host), specChips(s), realityTag, s.role === 'relay' ? h('span', { class: 'tag blue' }, '中转机') : null, vpsExpireTag(s), core_cf(s) && s.deployedAt ? h('span', { class: 'tag ' + (s.lastStatus?.cf ? 'blue' : 'warn'), title: s.lastStatus?.cf ? '' : '隧道服务没在运行：检查令牌是否正确、VPS 能否连上 Cloudflare' }, s.lastStatus?.cf ? 'CF 隧道' : 'CF 隧道未连通') : null,
        core_xray(s) && s.deployedAt && st && !st.xray ? h('span', { class: 'tag warn', title: 'XHTTP 协议由 Xray 提供，Xray 没在运行。点「同步」重试，或「更多 → 查看日志」看原因；其它协议不受影响' }, 'Xray 未运行') : null),
      h('td', { class: 'st-cell' }, h('div', { class: 'st-top' }, status, st?.version ? h('span', { class: 'muted', style: { fontSize: '12px' }, title: st.xrayVersion ? 'Xray ' + st.xrayVersion : '' }, 'sing-box ' + st.version + (st.xrayVersion ? ' · Xray ' + st.xrayVersion : '')) : null, agentOutdated(s) ? h('span', { class: 'tag warn', title: '点「同步」自动升级' }, 'agent 待升级') : null), s.deployedAt ? serverMeters(s) : null),
      h('td', {}, protos.length ? h('div', { class: 'proto-list' }, protos) : h('span', { class: 'muted' }, '无'), fw ? h('span', { class: 'tag blue', style: { marginTop: '6px' } }, `转发 ${fw}`) : null),
      h('td', {}, exit),
      h('td', {}, h('div', { class: 'srv-actions' },
        s.deployedAt
          ? h('button', { class: 'small primary', title: '把当前配置推送到服务器（改了设置后点）', onclick: (e) => busy(e.currentTarget, async () => { await api.call('server:sync', s.id); toast('已同步', 'ok'); dirty = false; renderBanner(); render(); }) }, '同步')
          : h('button', { class: 'small primary', onclick: () => deployServer(s) }, '部署'),
        h('button', { class: 'small', title: '一步步检查 SSH、服务、端口、是否被墙、节点真连', onclick: () => diagnoseServer(s) }, '体检'),
        h('button', { class: 'small', onclick: () => editServer(s) }, '编辑'),
        h('button', { class: 'small icon-more', title: '更多操作', onclick: (e) => menu(e.currentTarget, [
          s.deployedAt && { label: '监控面板', onClick: () => showMonitor(s) },
          s.deployedAt && { label: '网络优化（线路 / 测速 / BBR）', onClick: () => showNetLab(s) },
          s.deployedAt && core_reality(s) && { label: 'Reality 目标质量', onClick: () => realityQuality(s) },
          s.deployedAt && core_reality(s) && { label: '重新优选 Reality 目标', onClick: () => repickReality(s) },
          s.deployedAt && { sep: true },
          s.deployedAt && { label: '刷新状态', onClick: async () => { await api.call('server:status', s.id); toast('已刷新', 'ok'); render(); } },
          s.deployedAt && { label: '查看日志', onClick: () => showLogs(s) },
          s.deployedAt && { label: core_xray(s) ? '升级内核（sing-box + Xray）' : '升级 sing-box 内核', onClick: async () => { toast('正在检查内核更新…'); const m = await api.call('server:updateSingbox', s.id); toast(m, 'ok'); render(); } },
          s.deployedAt && { label: '重新部署', onClick: () => deployServer(s) },
          { label: '一键换新（被墙时用）', onClick: () => rotateServer(s) },
          { label: '清理其他面板 / 程序', onClick: () => cleanOthers(s) },
          { sep: true },
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

async function checkRealityNow(s) { return realityQuality(s); }

// Reality 目标质量：把「能不能用」和「好不好」分开讲清楚
async function realityQuality(s) {
  const body = h('div', {}, h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' 正在 VPS 上和这台电脑上检测目标网站…（约 10 秒）'));
  modal({ title: `Reality 目标质量 · ${s.name}`, wide: true, body, buttons: [
    { label: '重新优选目标', close: true, onClick: () => repickReality(s) },
    { label: '关闭', class: 'primary' },
  ] });
  let q;
  try { q = await api.call('server:realityQuality', s.id); } catch (e) { body.innerHTML = ''; body.append(h('p', {}, h('span', { class: 'tag bad' }, '检测失败'), ' ', e.message)); return; }
  const R = q.remote || {}; const L = q.local || {};
  const ip4 = (x) => /^\d+\.\d+\.\d+\.\d+$/.test(x || '') ? x.split('.') : null;
  const a = ip4(q.vpsHost); const b = ip4(R.ip);
  const near = a && b ? (a.slice(0, 3).join('.') === b.slice(0, 3).join('.') ? 24 : a.slice(0, 2).join('.') === b.slice(0, 2).join('.') ? 16 : 0) : null;
  const basicOk = !!R.ok; const cnOk = !!L.ok;
  const ms = R.ms || 0;
  const rows = [];
  const row = (lvl, name, value, why) => rows.push(h('div', { class: 'q-row' }, h('span', { class: 'q-dot ' + lvl }), h('div', { class: 'q-name' }, name), h('div', { class: 'q-val' }, value), h('div', { class: 'q-why muted' }, why)));
  row(basicOk ? 'ok' : 'bad', '基本条件', basicOk ? 'TLS 1.3 · HTTP/2 · X25519 · 证书有效' : (R.error || '不通过'),
    basicOk ? 'Reality 要求的四项都满足（在 VPS 上测的）' : '不满足就完全不能用，客户端连不上');
  row(cnOk ? 'ok' : 'bad', '国内能连上', cnOk ? `能（这台电脑 ${L.ms} ms）` : `连不上：${L.error || ''}`,
    cnOk ? '目标网站在国内没被屏蔽，客户端不会因为这个域名被掐断' : '这个域名在国内被屏蔽或干扰，客户端一连就会被掐断，必须换（如果这台电脑开着全局代理，这项结果不准）');
  row(!basicOk ? 'idle' : ms <= 20 ? 'ok' : ms <= 80 ? 'ok' : ms <= 200 ? 'warn' : 'bad', 'VPS 到目标', basicOk ? `握手 ${ms} ms` : '—',
    'Reality 在握手时要去连一次目标网站。越近越好：几毫秒说明就在隔壁；上百毫秒会让每次新连接都慢一点，延迟和你的机房对不上也更容易被看出来');
  row(near == null ? 'idle' : near ? 'ok' : 'warn', '和 VPS 的网络位置', near == null ? '—' : near === 24 ? `同网段（${R.ip}）` : near === 16 ? `同一片网络（${R.ip}）` : `不同网络（${R.ip}）`,
    near == null ? (R.ip ? '服务器地址填的是域名，没法比较' : 'VPS 上的 agent 是旧版，没有返回目标 IP，点「同步」升级后再看') : near === 24 ? '目标网站和你的 VPS 在同一个机房网段，外面看起来就像在访问隔壁网站，最自然' : near === 16 ? '离得比较近，比较自然' : '域名和 IP 的归属对不上（比如用微软的域名，IP 却是别家机房的），是可以被识别的特征之一，不过很多人这样用也没问题');
  const p = q.patrol;
  if (p && (p.lastCheck || p.fails)) row(p.fails ? 'warn' : 'ok', '巡检记录', p.fails ? `最近连续失败 ${p.fails} 次` : `最近一次正常${p.lastCheck ? '（' + fmtDate(p.lastCheck * 1000) + '）' : ''}`, 'VPS 每 6 小时检查一次目标网站，连续失败会自动换（设置里可改）');
  let grade; let gradeCls; let advice;
  if (!basicOk || !cnOk) { grade = '不能用'; gradeCls = 'bad'; advice = '点下面的「重新优选目标」换一个。'; }
  else if (near === 24 && ms <= 30) { grade = '很好'; gradeCls = 'ok'; advice = '同网段邻居、握手很快，是最理想的情况，不用换。'; }
  else if (ms <= 80) { grade = '良好'; gradeCls = 'ok'; advice = near === 0 ? '能用、速度也可以。想更隐蔽可以试试「重新优选」，看能不能找到同网段的邻居网站。' : '能用，不用换。'; }
  else { grade = '可以用'; gradeCls = 'warn'; advice = 'VPS 到目标比较远，新连接会慢一点。可以试试「重新优选」。'; }
  const src = { neighbor: '同网段邻居（自动挑选）', fallback: '主流大站（自动挑选）' }[q.source] || (q.auto ? '自动挑选' : '手动指定');
  body.innerHTML = '';
  body.append(
    h('div', { class: 'q-head' }, h('div', {}, h('div', { class: 'q-domain mono' }, q.domain), h('div', { class: 'muted' }, src)), h('div', { class: 'q-grade ' + gradeCls }, grade)),
    h('div', { class: 'q-list' }, rows),
    h('p', { style: { margin: '12px 0 0' } }, h('b', {}, '建议：'), advice),
    h('details', { class: 'q-more' }, h('summary', {}, '邻居网站一定比大厂域名好吗？'),
      h('p', {}, '不一定，各有长处。目标网站只在握手时用到，连上以后的速度和它无关。'),
      h('p', {}, '邻居网站的好处是「自然」：域名和你的 VPS 在同一个机房，握手只要几毫秒，外面看起来就像在访问隔壁的网站。缺点是小网站可能哪天下线、证书过期，不过巡检会自动发现并更换。'),
      h('p', {}, '大厂域名（微软、苹果等）的好处是稳定、永远在线。缺点是域名和 IP 的归属对不上，用的人也多，是能被识别的特征之一；VPS 到它们通常也更远。'),
      h('p', { style: { marginBottom: 0 } }, '所以判断标准是：先看「基本条件」和「国内能连上」两项必须通过，再看延迟越低、离 VPS 越近越好。两种都能用，邻居更隐蔽，大厂更省心。')));
}

async function editServer(orig, opts = {}) {
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
  // SSH 主机指纹（第一次连上时自动记录，之后每次核对，防止有人在中间截获密码）
  const hostKeyBox = h('div', { class: 'muted', style: { fontSize: '12px', margin: '-4px 0 10px' } });
  const drawHostKey = () => {
    hostKeyBox.innerHTML = '';
    if (!s.hostKey) { hostKeyBox.append('SSH 主机指纹：第一次连接时自动记录，之后每次连接都会核对'); return; }
    hostKeyBox.append('SSH 主机指纹 ', h('span', { class: 'mono' }, s.hostKey), ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); s.hostKey = ''; drawHostKey(); toast('保存后，下次连接会重新记录指纹（只在重装过系统时这样做）'); } }, '重置指纹'));
  };
  drawHostKey();
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

  const quotaIn = I(s.quotaGB || '', { type: 'number', min: 0, placeholder: '不填 = 不显示' });
  const groupIn = I(s.group || '', { placeholder: '不填 = 不分组' });
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
    if (k === 'vlessXhttpReality' || k === 'vlessXhttpTls') {
      els.path = I(pc.path || ''); extra.push(field('XHTTP 路径', h('div', { class: 'row' }, els.path, h('button', { class: 'small auto', onclick: () => { els.path.value = '/' + randStr(8).toLowerCase(); } }, '随机'))));
      extra.push(h('p', { class: 'muted', style: { fontSize: '12px', margin: 0 } }, k === 'vlessXhttpReality'
        ? '由 Xray 内核提供（勾上后部署 / 同步时自动安装）。和上面的 VLESS-Reality 共用 Reality 目标和密钥，目标在 VLESS-Reality 里设置。不能和 VLESS-Reality 用同一个端口。客户端：v2rayN / v2rayNG（Xray 内核）。Clash 系客户端（mihomo）暂时连不上新版 Xray 的 Reality，sing-box 客户端不支持 XHTTP，这两种订阅里会自动去掉它。'
        : '由 Xray 内核提供，走 HTTP/2 + TLS，用上面的自签证书（链接带证书指纹）；填了域名并开启正式证书时自动用正式证书。也可以套 CDN（需要正式证书）。sing-box 客户端不支持，订阅里会自动去掉。'));
      const mem = orig?.hw?.memMB;
      if (mem && mem < 1024) extra.push(h('p', { style: { fontSize: '12px', margin: 0, color: 'var(--warn)' } }, `⚠ 这台机器只有 ${mem}MB 内存。开了 XHTTP 会多跑一个 Xray 内核（空载约 30–60MB，连接多时更多），和 sing-box 一起可能内存紧张；建议只开一个 XHTTP 协议，或加 swap（「更多 → 小机器优化」）。`));
    }
    protoEls[k] = els;
    grid.append(h('div', { class: 'proto', 'data-proto': k }, h('div', { class: 'head' }, h('label', {}, en, ' ', h('b', {}, label)), h('span', { class: 'muted' }, netw.toUpperCase())), field('端口', pt), h('label', { class: 'muted', style: { fontSize: '12px', display: 'block', margin: '-4px 0 8px' }, title: '勾上后，部署后端口不通或一键换新时都不会自动换这个端口' }, fixed, ' 固定端口（不自动更换）'), extra));
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
    pwdBox, keyBox, hostKeyBox,
    h('div', { class: 'row' }, field('角色', role), field('出口', exit), field('VPS 到期日（可选）', vpsExp, '到期前 7 天和 1 天会发通知提醒续费')),
    h('div', { class: 'row' }, field('每月流量额度 GB（可选）', quotaIn, '探针网页上显示用量进度'), field('分组（可选）', groupIn, '探针网页可以按分组筛选，例如「日本」「备用」')),
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
    h('label', { class: 'f', 'data-proto': 'cf' }, cfOn, ' 通过 Cloudflare Tunnel 接入 VMess-WS（IP 被墙或不想暴露端口时用）'),
    cfBox);

  const collect = () => {
    s.name = name.value.trim() || host.value.trim();
    s.host = host.value.trim();
    s.sshPort = Number(port.value) || 22;
    if (orig && (s.host !== orig.host || s.sshPort !== (Number(orig.sshPort) || 22))) s.hostKey = ''; // 换了地址 / 端口：重新记录指纹
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
    s.quotaGB = Math.max(0, Number(quotaIn.value) || 0);
    s.group = groupIn.value.trim().slice(0, 20);
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
      const mem = orig?.hw?.memMB;
      if (mem && mem < 1024 && core_xray(ns) && !core_xray(orig)) {
        if (!(await confirmBox(`这台机器只有 ${mem}MB 内存，开 XHTTP 会多跑一个 Xray 内核，和 sing-box 一起可能内存紧张、被系统杀进程。还要开吗？`))) return false;
      }
      // 已部署的服务器换了固定 Reality 目标：先在 VPS 上检测，通过才保存（24 小时内通过的结果可沿用）
      const rp = ns.protocols?.vlessReality;
      const op = orig?.protocols?.vlessReality;
      if (orig?.deployedAt && core_reality(ns) && !rp.sniAuto && (rp.sni !== op?.sni || op?.sniAuto || !core_reality(orig))) {
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
      if (orig?.deployedAt && core_reality(ns) && rp.sniAuto && !orig.protocols?.vlessReality?.sniAuto) repickReality(ns); // 从固定改成自动：马上挑一次
      await render();
    } },
  ] });
  // 从节点页点「编辑」进来：滚到那个协议并高亮
  if (opts.focus) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.modal [data-proto="${opts.focus}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('focus'); }
    });
  }
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
// 服务器列表：配置做成小标签（核数 / 内存 / swap）
function specChips(s) {
  const hw = s.hw;
  if (!hw?.memMB) return null;
  const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace(/\.0$/, '') + ' GB' : mb + ' MB');
  return h('div', { class: 'chips' }, h('span', { class: 'chip' }, `${hw.cpus || '?'} 核`), h('span', { class: 'chip' }, gb(hw.memMB)), hw.swapMB ? h('span', { class: 'chip', title: '虚拟内存' }, 'swap ' + gb(hw.swapMB)) : null,
    !s.deployedAt && hw.diskFreeMB ? h('span', { class: 'chip' }, '磁盘剩 ' + gb(hw.diskFreeMB)) : null);
}

// 服务器列表：CPU / 内存 / 磁盘做成小仪表，和监控面板一样一眼能看出松紧
function serverMeters(s) {
  const st = s.lastStatus;
  if (!st) return h('div', { class: 'muted', style: { fontSize: '12px' } }, '还没有状态，点「同步」或「刷新状态」');
  const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1).replace(/\.0$/, '') + 'G' : Math.round(mb) + 'M');
  let memU = st.memUsed; let memT = st.memTotal;
  if (!memT && st.mem) { const m = String(st.mem).match(/(\d+)\/(\d+)/); if (m) { memU = +m[1]; memT = +m[2]; } } // 旧版状态只有文字
  const cores = st.cpus || s.hw?.cpus || 1;
  const load1 = parseFloat(String(st.load || '').split(' ')[0]) || 0;
  const cpu = st.cpu != null ? st.cpu : Math.min(100, Math.round((load1 / cores) * 100));
  const lvl = (p, w, d) => (p >= d ? 'bad' : p >= w ? 'warn' : 'ok');
  const meter = (label, pct, text, title) => h('div', { class: 'meter', title: title || '' }, h('span', { class: 'm-l' }, label), h('div', { class: 'm-bar' }, h('i', { class: lvl(pct, 70, 90), style: { width: Math.max(2, Math.min(100, pct)) + '%' } })), h('span', { class: 'm-v' }, text));
  const out = [meter('CPU', cpu, `${cpu}%`, `负载 ${st.load || '—'}（${cores} 核）`)];
  if (memT) { const p = Math.round((memU / memT) * 100); out.push(meter('内存', p, `${gb(memU)} / ${gb(memT)}`, `已用 ${p}%（不含可回收的缓存）`)); }
  if (st.diskTotal) { const p = Math.round((st.diskUsed / st.diskTotal) * 100); out.push(meter('磁盘', p, `${gb(st.diskUsed)} / ${gb(st.diskTotal)}`, `已用 ${p}%`)); }
  const up = st.uptimeSec ? (st.uptimeSec >= 86400 ? `${Math.floor(st.uptimeSec / 86400)} 天` : st.uptimeSec >= 3600 ? `${Math.floor(st.uptimeSec / 3600)} 小时` : `${Math.max(1, Math.floor(st.uptimeSec / 60))} 分钟`) : '';
  return h('div', { class: 'meters' }, out, h('div', { class: 'm-foot muted' }, `负载 ${(st.load || '—').split(' ')[0]}`, up ? ` · 已运行 ${up}` : '', st.at ? ` · ${fmtAgo(st.at)}更新` : ''));
}
function fmtAgo(t) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; }

function hwLine(s) {
  const hw = s.hw;
  if (!hw?.memMB) return null;
  const gb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace(/\.0$/, '') + ' GB' : mb + ' MB');
  const small = hw.memMB <= 1536;
  return h('div', { class: 'muted', style: { fontSize: '12px' }, title: small ? '小内存机器：NodeDeck 已限制内存上限。空闲约占 50MB，每个正在传数据的连接约 0.5–0.8MB' : '' },
    `${hw.cpus || '?'} 核 · ${gb(hw.memMB)}${hw.swapMB ? ` + swap ${gb(hw.swapMB)}` : ''} · 磁盘剩 ${gb(hw.diskFreeMB)}`);
}

// 国内按 SNI 屏蔽的常见域名（TLS / QUIC 握手里带这些名字会被直接重置）
const SNI_BLOCKED = ['google.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com', 'youtube.com', 'ytimg.com', 'facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com', 'whatsapp.net', 'twitter.com', 'x.com', 'twimg.com', 'telegram.org', 't.me', 'wikipedia.org', 'wikimedia.org', 'netflix.com', 'reddit.com', 'discord.com', 'discord.gg', 'pinterest.com', 'dropbox.com', 'openai.com', 'chatgpt.com', 'blogspot.com', 'nytimes.com', 'medium.com', 'github.io', 'pornhub.com', 'xvideos.com', 'onlyfans.com', 'bbc.com', 'voanews.com', 'rfa.org', 'theepochtimes.com', 'ntdtv.com']; // 和 core.js 一致
function sniBlocked(d) {
  d = String(d || '').toLowerCase();
  return SNI_BLOCKED.some((b) => d === b || d.endsWith('.' + b));
}

// XHTTP 协议由 Xray 提供；XHTTP-Reality 和 VLESS-Reality 共用 Reality 目标和密钥
function core_xray(s) { return !!(s.protocols?.vlessXhttpReality?.enabled || s.protocols?.vlessXhttpTls?.enabled); }
function core_reality(s) { return !!(s.protocols?.vlessReality?.enabled || s.protocols?.vlessXhttpReality?.enabled); }
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
function lineChart(title, series, { unit = '', fmt = (v) => v.toFixed(1) + unit, max, empty, note } = {}) {
  // series: [{ name, points: [[t, v]] }]
  const W = 390, H = 150, L = 62, R = 8, T = 10, B = 22;
  const all = series.flatMap((x) => x.points);
  const box = h('div', { class: 'card chart' }, h('div', { class: 'chart-head' }, h('b', {}, title), h('span', { class: 'legend', title: '图例里是这段时间的平均值' }, series.map((x, i) => h('span', {}, h('i', { style: { background: CHART_COLORS[i] } }), x.name, x.points.length ? ' 均 ' + fmt(x.points.reduce((a, p) => a + p[1], 0) / x.points.length) : '')))));
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
  box.append(h('div', { html: svg }), note ? h('div', { class: 'muted chart-note' }, note) : '');
  return box;
}
function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function gauge(label, pct, text) {
  const cls = pct >= 90 ? 'full' : '';
  return h('div', { class: 'card stat' }, h('div', { class: 'n', style: { fontSize: String(text).length > 16 ? '16px' : '20px', whiteSpace: 'nowrap' } }, text), h('div', { class: 'l' }, label), pct >= 0 ? h('div', { class: 'progress' }, h('i', { class: cls, style: { width: Math.min(100, pct) + '%' } })) : null);
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
    const live = m.live || n; // 新版 agent 打开时现测 1 秒；老版用最近一分钟的平均
    const dpct = m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : -1;
    const expDays = s.vpsExpireAt ? Math.ceil((s.vpsExpireAt - Date.now()) / 86400000) : null;
    const since = m.month?.since ? new Date(m.month.since * 1000) : null;
    const series = m.series || [];
    const steal = Math.max(0, ...series.map((x) => x.steal || 0));
    body.append(
      h('div', { class: 'tabs' }, [['1h', '1 小时'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']].map(([k, l]) => h('a', { class: range === k ? 'active' : '', onclick: () => { range = k; load(); } }, l))),
      h('div', { class: 'grid g4' },
        gauge(`CPU（${m.cores || '?'} 核）${m.live ? ' · 实时' : ''}${live.steal >= 3 ? ` · 宿主机占用 ${live.steal.toFixed(0)}%` : ''}`, live.cpu ?? -1, live.cpu != null ? live.cpu.toFixed(1) + '%' : '—'),
        gauge('内存', live.mem ?? -1, live.mem != null ? live.mem.toFixed(1) + '%' : '—'),
        gauge('硬盘', dpct, m.diskTotal ? `${fmtBytes(m.diskUsed)} / ${fmtBytes(m.diskTotal)}` : '—'),
        gauge(`本月网卡流量（${since ? `${since.getMonth() + 1} 月 ${since.getDate()} 日起` : m.month?.month || ''}）`, -1, `↑${fmtBytes(m.month?.tx)} ↓${fmtBytes(m.month?.rx)}`)),
      h('p', { class: 'muted', style: { margin: '8px 0' } }, `已运行 ${fmtDur(m.uptime || 0)} · 负载 ${live.load != null ? live.load.toFixed(2) : '—'} · 网卡${m.live ? '实时' : ''} ↑${fmtRate(live.tx || 0)} ↓${fmtRate(live.rx || 0)}${n.conn ? ` · ${n.conn} 个 TCP 连接` : ''}`,
        expDays != null ? [' · ', h('span', { class: expDays <= 7 ? 'tag warn' : '' }, expDays < 0 ? 'VPS 已过期' : `VPS 还有 ${expDays} 天到期`)] : ' · 没填 VPS 到期日（编辑服务器里可以填）'));
    const pts = (k) => series.map((x) => [x.t, x[k] || 0]);
    const latKeys = [...new Set(series.flatMap((x) => Object.keys(x.lat || {})))];
    const hasProxy = series.some((x) => 'pdown' in x);
    body.append(h('div', { class: 'grid g2' },
      lineChart('CPU / 内存', [{ name: 'CPU', points: pts('cpu') }, { name: '内存', points: pts('mem') }, ...(steal >= 3 ? [{ name: '宿主机占用', points: pts('steal') }] : [])], { unit: '%', max: 100, fmt: (v) => v.toFixed(0) + '%', note: steal >= 5 ? '「宿主机占用」（steal）持续偏高说明这台 VPS 所在的宿主机比较挤（超售），CPU 实际可用的会变少' : null }),
      lineChart('代理流量（所有用户合计）', [{ name: '用户下载', points: series.filter((x) => 'pdown' in x).map((x) => [x.t, x.pdown]) }, { name: '用户上传', points: series.filter((x) => 'pup' in x).map((x) => [x.t, x.pup]) }], { fmt: (v) => fmtRate(v), empty: hasProxy ? null : '新版 agent 才有（点「同步」升级后开始采集）' }),
      lineChart('网卡速率', [{ name: '发送', points: pts('tx') }, { name: '接收', points: pts('rx') }], { fmt: (v) => fmtRate(v), note: '代理是转发：从网站收进来多少，就发给用户多少，所以发送和接收通常差不多' }),
      lineChart('三网延迟（ping）', latKeys.map((k) => ({ name: k, points: series.filter((x) => x.lat && x.lat[k] > 0).map((x) => [x.t, x.lat[k]]) })), { fmt: (v) => v.toFixed(0) + 'ms', empty: S.settings.latencyProbe ? '暂无数据（VPS 连不上国内测速点，或刚开始采集）' : '后台记录三网延迟没开（设置 → 巡检与告警），可以在「网络优化 → 质量」里手动测' }),
      lineChart('TCP 重传率', [{ name: '重传', points: pts('retr') }], { fmt: (v) => v.toFixed(2) + '%', note: '发出去的数据有多少要重发，能看出线路丢包；不含连不上目标时的 SYN 重发。长期高于 2% 说明线路有丢包' }),
      lineChart('负载', [{ name: '1 分钟', points: pts('load') }], { fmt: (v) => v.toFixed(2) })));
  };
  modal({ title: `监控 · ${s.name}`, wide: true, body, buttons: [{ label: '刷新', close: false, onClick: load }, { label: '关闭' }] });
  load();
}
