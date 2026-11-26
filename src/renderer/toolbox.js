'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → settings.js（最后一个启动界面）

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
    const srv = h('select', { class: 'auto', style: { width: '220px' } }, h('option', { value: '' }, '仅本机检测'), S.servers.filter((s) => s.deployedAt).map((s) => h('option', { value: s.id }, `同时从 ${s.name} 检测`)));
    if (S.servers.some((s) => s.deployedAt)) srv.value = S.servers.find((s) => s.deployedAt).id; // 默认带上 VPS，结果以 VPS 为准
    const out = h('div', {});
    box.append(h('p', { class: 'muted' }, 'Reality 目标要求：TLS 1.3、HTTP/2、X25519，且离 VPS 越近越好（从服务器检测的延迟越低越好）。'),
      h('div', { class: 'row' }, d, srv, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
        const r = await api.call('tools:reality', d.value, srv.value);
        out.innerHTML = '';
        const remote = r.remote ? { at: Date.now(), ...r.remote } : null;
        out.append(h('div', { style: { marginTop: '12px' } }, realityResultTable(r.local, remote)),
          h('p', { class: 'muted', style: { fontSize: '12px' } }, remote ? 'Reality 是 VPS 去连目标网站，能不能用以 VPS 的结果为准；本机结果只说明你这边能否访问。鼠标停在结果上能看到具体数值。' : '没选服务器，只做了本机检测。选一台已部署的服务器可以同时在 VPS 上检测，以 VPS 结果为准。'));
      }) }, '检测')), out);
    // 从服务器扫描附近的 Reality 目标
    const scanSrv = h('select', { class: 'auto', style: { width: '220px' } }, S.servers.filter((x) => x.deployedAt).map((x) => h('option', { value: x.id }, x.name)));
    const scanOut = h('div', {});
    box.append(h('h4', { style: { marginTop: '22px' } }, '从服务器扫描附近目标'),
      h('p', { class: 'muted' }, '在 VPS 上扫描同网段的 IP，找出支持 TLS 1.3 + HTTP/2 的网站。同机房的网站延迟最低，最适合做 Reality 目标。需要 1~2 分钟。'),
      S.servers.some((x) => x.deployedAt) ? h('div', { class: 'row' }, scanSrv, h('button', { class: 'primary auto', onclick: (e) => busy(e.currentTarget, async () => {
        scanOut.innerHTML = '';
        const list = await api.call('tools:realityScan', scanSrv.value);
        if (!list.length) { scanOut.append(h('p', { class: 'muted' }, '附近没找到合适的网站，可以用上面手动检测 www.microsoft.com、www.apple.com 这类大站。')); return; }
        const srv = S.servers.find((x) => x.id === scanSrv.value);
        scanOut.append(h('table', { style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['域名', 'IP', '延迟', '证书签发', '到期', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, list.map((r) => h('tr', {}, h('td', { class: 'mono' }, r.domain), h('td', { class: 'mono muted' }, r.ip), h('td', {}, r.ms + ' ms'), h('td', { class: 'muted' }, r.issuer), h('td', { class: 'muted' }, r.notAfter),
            h('td', {}, h('button', { class: 'small', onclick: async () => {
              const cur = S.servers.find((x) => x.id === srv.id);
              // 选了扫描结果就是固定目标；同步时会在 VPS 上按完整标准再检测一次
              cur.protocols.vlessReality = { ...cur.protocols.vlessReality, sni: r.domain, sniAuto: false, sniPickedAt: undefined, sniSource: undefined };
              await api.call('col:upsert', 'servers', cur); markDirty();
              toast(`${srv.name} 的 Reality 目标改成 ${r.domain}，同步后生效`, 'ok');
            } }, '用这个')))))));
      }) }, '开始扫描')) : h('p', { class: 'muted' }, '先部署一台服务器'), scanOut);
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
