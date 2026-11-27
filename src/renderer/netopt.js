'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

// ---------- 网络优化 ----------
const NET_TABS = [['overview', '内核设置'], ['route', '线路'], ['quality', '质量 / 晚高峰'], ['speed', '测速 / UDP'], ['compare', 'BBR 对比'], ['bench', '社区测试']];
let netTab = 'overview';
const fmtMbps = (v) => (v == null ? '—' : v >= 100 ? v.toFixed(0) + ' Mbps' : v.toFixed(1) + ' Mbps');
const fmtPct = (v, d = 1) => (v == null ? '—' : v.toFixed(d) + '%');
const fmtMs = (v) => (v == null || v < 0 ? '—' : v.toFixed(0) + ' ms');
const netAgo = (t) => (t ? fmtDate(t) : '');

function showNetLab(srv) {
  const id = srv.id;
  const body = h('div', {});
  const logBox = h('pre', { class: 'log hidden', style: { maxHeight: '140px', marginTop: '12px' } });
  const off = api.on('task-log', (m) => {
    if (m.task !== 'net:' + id) return;
    logBox.classList.remove('hidden'); logBox.textContent += m.line + '\n'; logBox.scrollTop = logBox.scrollHeight;
  });
  // 社区测试的输出轮询：每个脚本一个，用 setTimeout 串行（SSH 慢时不会重叠、重复追加输出）；重画界面时全部停掉，新界面会重新接上
  const polls = {};
  const stopPolls = () => { for (const k of Object.keys(polls)) { clearTimeout(polls[k].t); delete polls[k]; } };
  const S1 = () => S.servers.find((x) => x.id === id) || srv;
  const lab = () => S1().netLab || {};
  const run = (btn, fn) => busy(btn, async () => { await fn(); await reload(); draw(); });
  const note = (t) => h('p', { class: 'muted', style: { fontSize: '12px', margin: '6px 0 0' } }, t);
  const tabs = h('div', { class: 'tabs' });
  const pane = h('div', {});
  body.append(tabs, pane, logBox);

  function draw() {
    stopPolls();
    tabs.innerHTML = '';
    for (const [k, l] of NET_TABS) tabs.append(h('a', { class: netTab === k ? 'active' : '', onclick: () => { netTab = k; draw(); } }, l));
    pane.innerHTML = '';
    ({ overview, route, quality, speed, compare, bench })[netTab]();
  }

  // 重传率：优先用最近 1 小时（agent 每分钟记一次），没有就用开机以来；都不含 SYN 重传（连不上的目标反复发 SYN，不代表线路丢包）
  function retrText(t) {
    const recent = t.retransPct1h != null && t.retransPct1h >= 0;
    const v = recent ? t.retransPct1h : t.retransPct;
    const lvl = v > 5 ? ' — 很高，线路丢包明显' : v > 2 ? ' — 偏高，线路可能有丢包' : v > 0.5 ? ' — 正常' : ' — 很低';
    const syn = t.synRetrans != null ? '，不含连不上目标时的 SYN 重发' : '';
    return h('span', {}, `${fmtPct(v, 2)}`, h('span', { class: 'muted' }, `（${recent ? `最近 1 小时平均` : '开机以来'}${syn}）`), lvl,
      recent ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `开机以来 ${fmtPct(t.retransPct, 2)}`) : null);
  }

  // 1. 内核设置
  function overview() {
    const ni = lab().info;
    const top = h('div', { class: 'toolbar' }, h('div', { class: 'muted' }, ni ? `检测时间 ${netAgo(ni.at)}` : '还没检测过'), h('div', { class: 'spacer' }),
      h('button', { class: ni ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:info', id)) }, ni ? '重新检测' : '检测'));
    pane.append(top);
    if (!ni) { pane.append(note('会读取内核版本、拥塞控制、发包队列、网卡、IPv4 / IPv6 和 TCP 重传情况，只读不改。')); return; }
    const kv2 = (k, v) => [h('div', { class: 'k' }, k), h('div', {}, v)];
    pane.append(h('div', { class: 'card' }, h('div', { class: 'kv' },
      kv2('系统内核', ni.kernel + (ni.container ? `（${ni.virt} 容器：大部分内核参数由宿主机决定）` : '')),
      kv2('BBR', h('span', { class: 'tag ' + (ni.cc === 'bbr' ? 'ok' : ni.bbrSupport ? 'warn' : 'bad') }, ni.bbrNote)),
      kv2('拥塞控制', `${ni.cc}（可用：${(ni.ccAvail || []).join('、')}）`),
      kv2('发包队列', `${ni.qdisc}${ni.iface?.qdisc ? `，网卡当前 ${ni.iface.qdisc}` : ''}`),
      kv2('网卡', `${ni.iface?.name || '?'} · ${ni.iface?.driver || ''} · MTU ${ni.iface?.mtu || '?'} · ${ni.iface?.txQueues || 1} 个发送队列${ni.iface?.speed ? ' · ' + ni.iface.speed : ''}`),
      kv2('IPv4 / IPv6', `${ni.ipv4 ? '有' : '无'} / ${ni.ipv6 ? '有' : '无'}`),
      kv2('TCP 重传率', retrText(ni.tcp || {})),
      kv2('TCP 连接', `${ni.tcp?.established || 0} 个已建立 · ${ni.tcp?.timeWait || 0} 个等待关闭`))));
    const pending = (ni.items || []).filter((x) => x.apply);
    const cbs = {};
    const list = h('div', { class: 'card' }, h('h3', {}, pending.length ? `建议调整 ${pending.length} 项` : '设置已经合适'),
      note('只改有依据的几项。改之前会备份原值，随时可以「恢复原始设置」。勾掉的不会改。'));
    for (const it of ni.items || []) {
      const cb = it.apply ? h('input', { type: 'checkbox', checked: true }) : null;
      if (cb) cbs[it.key] = cb;
      list.append(h('div', { class: 'diag-step' },
        it.apply ? h('label', { style: { gridRow: 'span 2' } }, cb, ' 改') : h('span', { class: 'tag ok' }, '合适'),
        h('div', {}, h('b', {}, it.name), ' ', h('span', { class: 'mono muted' }, it.apply ? `${it.cur} → ${it.want}` : it.cur),
          h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, it.why))));
    }
    list.append(h('div', { class: 'toolbar', style: { marginTop: '12px', marginBottom: 0 } },
      pending.length ? h('button', { class: 'primary', onclick: (e) => run(e.currentTarget, async () => {
        const keys = Object.entries(cbs).filter(([, c]) => c.checked).map(([k]) => k);
        if (!keys.length) { toast('没有勾选', 'warn'); return; }
        const r = await api.call('net:tune', id, keys);
        toast((r.done?.length ? '已调整：\n' + r.done.join('\n') : '没有改动') + (r.error ? '\n' + r.error : ''), r.error ? 'warn' : 'ok');
      }) }, '应用勾选的调整') : null,
      ni.backup ? h('button', { onclick: (e) => run(e.currentTarget, async () => {
        if (!(await confirmBox('把网络设置恢复成第一次调整前的样子？'))) return;
        const r = await api.call('net:restore', id);
        toast(r.error || (r.done?.length ? '已恢复：\n' + r.done.join('\n') : '已经是原始设置'), r.error ? 'warn' : 'ok');
      }) }, '恢复原始设置') : null));
    pane.append(list);
  }

  // 2. 线路
  function route() {
    const tr = lab().trace; const fw = lab().fwd;
    const lineTag = (l) => h('span', { class: 'tag ' + (/未识别/.test(l) ? '' : /混合/.test(l) ? 'blue' : /GIA|CTGNET|9929|CMIN2/.test(l) ? 'ok' : /GT|CUG|10099/.test(l) ? 'blue' : 'warn') }, l);
    const hopsLine = (hops) => h('div', { class: 'mono muted', style: { fontSize: '11px', marginTop: '4px', wordBreak: 'break-all' } }, (hops || []).map((x) => `${x.ip}${x.ms ? ` ${x.ms.toFixed(0)}ms` : ''}`).join(' → '));
    const box1 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '回程（VPS → 国内三网）'), h('div', { class: 'spacer' }), tr ? h('span', { class: 'muted' }, netAgo(tr.at)) : null,
      h('button', { class: tr ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:trace', id)) }, tr ? '重新测' : '开始测（约 30 秒）')),
      note('从 VPS 到北京、上海、广州的电信 / 联通 / 移动做路由追踪，按经过的骨干网判断线路。回程决定下载速度，最重要。'));
    if (tr) {
      const tb = h('tbody');
      for (const r of tr.list || []) {
        const det = h('tr', { class: 'hidden' }, h('td', { colspan: 4 }, hopsLine(r.hops)));
        tb.append(h('tr', {}, h('td', {}, r.name), h('td', {}, r.error ? h('span', { class: 'tag bad' }, '失败') : lineTag(r.line)), h('td', { class: 'muted' }, r.error || r.lineTip),
          h('td', {}, r.hops?.length ? h('button', { class: 'small', onclick: () => det.classList.toggle('hidden') }, `${r.hops.length} 跳`) : '')), det);
      }
      box1.append(h('table', { style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['目标', '线路', '说明', ''].map((t) => h('th', {}, t)))), tb));
    }
    const box2 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '去程（你的电脑 → VPS）'), h('div', { class: 'spacer' }), fw ? h('span', { class: 'muted' }, netAgo(fw.at)) : null,
      h('button', { onclick: (e) => run(e.currentTarget, () => api.call('net:traceForward', id)) }, fw ? '重新测' : '开始测（约 1 分钟）')),
      note('用 Windows 自带的路由追踪。去程决定上传和延迟。开着代理软件的 TUN / 全局模式会测成代理的路线，先关掉。'));
    if (fw) box2.append(fw.error ? h('p', {}, h('span', { class: 'tag bad' }, '失败'), ' ', fw.error) : h('div', { style: { marginTop: '8px' } }, lineTag(fw.line), ' ', h('span', { class: 'muted' }, fw.lineTip), hopsLine(fw.hops)));
    pane.append(box1, box2);
  }

  // 3. 质量 / 晚高峰
  function quality() {
    const pg = lab().ping;
    const pbox = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '三网延迟 / 丢包 / 抖动'), h('div', { class: 'spacer' }), pg ? h('span', { class: 'muted' }, netAgo(pg.at)) : null,
      h('button', { class: pg ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:ping', id)) }, pg ? '重新测' : '测一次（约 5 秒）')),
      note('从 VPS 往国内电信、联通、移动各发 20 个 ping，流量很小。晚高峰（20–24 点）再测一次，可以对比平时和高峰的差别。'));
    if (pg) pbox.append(h('table', { style: { marginTop: '8px' } }, h('thead', {}, h('tr', {}, ['', '延迟', '丢包', '抖动', '最低 / 最高'].map((t) => h('th', {}, t)))),
      h('tbody', {}, Object.entries(pg.list || {}).map(([k, r]) => h('tr', {}, h('td', {}, k),
        r.recv ? [h('td', {}, fmtMs(r.avg)), h('td', { style: { color: r.loss >= 5 ? 'var(--danger)' : r.loss > 0 ? 'var(--warn)' : '' } }, fmtPct(r.loss, 0)), h('td', {}, fmtMs(r.jitter)), h('td', { class: 'muted' }, `${r.min.toFixed(0)} / ${r.max.toFixed(0)} ms`)]
          : h('td', { colspan: 4, class: 'muted' }, r.error || '全部丢包：可能是这条线路不通，也可能是对方不回应 ping'))))));
    pane.append(pbox);
    // 后台记录（设置里打开后才有）
    const out = h('div', {});
    pane.append(h('div', { class: 'card' }, h('h3', {}, '平时 vs 晚高峰（后台记录）'), out));
    if (!S.settings.latencyProbe) out.append(note('后台记录没开（默认关，省流量）。需要长期对比的话，在「设置 → 巡检与告警」里打开「后台记录三网延迟」，VPS 每 5 分钟测一次，攒一两天后这里会显示 7 天的平时和晚高峰对比。'));
    else {
      out.append(h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' 读取中…'));
      api.call('net:peak', id).then((r) => {
        out.innerHTML = '';
        const keys = Object.keys(r.report || {});
        if (!keys.length) { out.append(note('还没有数据：需要 0.7.0 以上的 agent（点「同步」升级），运行几个小时后再看。')); return; }
        const cell = (a, b, f, badAt) => { const worse = a != null && b != null && b > a * 1.3 && b > badAt; return h('td', {}, f(a), ' / ', h('span', { style: { color: worse ? 'var(--danger)' : '' } }, f(b))); };
        out.append(h('table', {}, h('thead', {}, h('tr', {}, ['', '延迟（平时 / 晚高峰）', '丢包', '抖动'].map((t) => h('th', {}, t)))),
          h('tbody', {}, keys.map((k) => { const x = r.report[k]; return h('tr', {}, h('td', {}, k), cell(x.off.lat, x.peak.lat, fmtMs, 20), cell(x.off.loss, x.peak.loss, (v) => fmtPct(v), 1), cell(x.off.jit, x.peak.jit, fmtMs, 5)); }))));
        if (r.now) out.append(note(`当前 TCP 重传率 ${fmtPct(r.now.retr, 2)} · TCP 连接 ${r.now.conn ?? '—'} 个（重传率持续高于 2% 说明线路丢包多）`));
      }).catch((e) => { out.innerHTML = ''; out.append(h('p', {}, h('span', { class: 'tag bad' }, '读取失败'), ' ', e.message)); });
    }
    const mtu = lab().mtu;
    const mbox = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, '路径 MTU'), h('div', { class: 'spacer' }), mtu ? h('span', { class: 'muted' }, netAgo(mtu.at)) : null,
      h('button', { onclick: (e) => run(e.currentTarget, () => api.call('net:mtu', id)) }, mtu ? '重新测' : '开始测')),
      note('测 VPS 到三网能通过的最大包。小于 1500 说明中间有隧道之类的设备，已开启的「路径 MTU 探测」会自动处理，一般不用管。'));
    if (mtu) mbox.append(h('div', { class: 'kv', style: { marginTop: '8px' } }, h('div', { class: 'k' }, '网卡 MTU'), h('div', {}, mtu.iface?.mtu || '?'),
      (mtu.paths || []).flatMap((p) => [h('div', { class: 'k' }, `到${p.name}`), h('div', {}, p.error ? h('span', { class: 'muted' }, p.error) : `${p.mtu}${p.mtu < 1500 ? '（比 1500 小）' : ''}`)])));
    pane.append(mbox);
  }

  // 4. 测速 / UDP
  function speed() {
    const sp = lab().speed; const ud = lab().udp;
    pane.append(note('测的是你这台电脑到 VPS 这一段，也就是用户实际走的路。测之前关掉代理软件的 TUN / 全局模式。每次测速会消耗 VPS 流量，速度越快用得越多（100 Mbps 约 400MB）。'));
    const b1 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, 'TCP 速度'), h('div', { class: 'spacer' }), sp ? h('span', { class: 'muted' }, netAgo(sp.at)) : null,
      h('button', { class: sp ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:speed', id)) }, sp ? '重新测' : '开始测（约 40 秒）')));
    const cell = (r, label) => h('div', {}, h('div', { class: 'n' }, !r || r.error ? '—' : fmtMbps(r.mbps).replace(' Mbps', ''), h('small', {}, ' Mbps')), h('div', { class: 'l' }, r?.error || label));
    if (sp) b1.append(h('div', { class: 'statstrip', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', marginTop: '10px', marginBottom: 0 } },
      cell(sp.down, '下载 · 单线程'), sp.downMulti ? cell(sp.downMulti, '下载 · 4 线程') : null,
      cell(sp.up, '上传 · 单线程'), sp.upMulti ? cell(sp.upMulti, '上传 · 4 线程') : null,
      h('div', {}, h('div', { class: 'n' }, sp.down?.ttfbMs ?? '—', h('small', {}, ' ms')), h('div', { class: 'l' }, '首字节时间'))),
      sp.downMulti ? note('单线程是一条连接能跑多快（看视频、下单个文件）；4 线程接近线路带宽。两者差很多说明线路延迟高或有丢包，单条连接跑不满，可以试试 BBR 或 Hysteria2。') : null);
    const b2 = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, 'UDP 丢包 / 抖动（Hysteria2、TUIC 走 UDP）'), h('div', { class: 'spacer' }), ud ? h('span', { class: 'muted' }, netAgo(ud.at)) : null,
      h('button', { class: ud ? '' : 'primary', onclick: (e) => run(e.currentTarget, () => api.call('net:udp', id)) }, ud ? '重新测' : '开始测（约 7 秒）')),
      note('每 20 毫秒发一个 1200 字节的包（和 QUIC 包差不多大），一共 250 个，看回来多少。'));
    if (ud) b2.append(ud.error && !ud.recv ? h('p', {}, h('span', { class: 'tag bad' }, '不通'), ' ', ud.error) : h('div', { class: 'statstrip', style: { marginTop: '10px', marginBottom: 0 } },
      h('div', {}, h('div', { class: 'n', style: { color: ud.loss >= 10 ? 'var(--danger)' : ud.loss >= 3 ? 'var(--warn)' : '' } }, ud.loss.toFixed(1), h('small', {}, ' %')), h('div', { class: 'l' }, `丢包（${ud.recv}/${ud.sent}）`)),
      h('div', {}, h('div', { class: 'n' }, ud.avg.toFixed(0), h('small', {}, ' ms')), h('div', { class: 'l' }, `延迟（最低 ${ud.min.toFixed(0)}，95% ${ud.p95.toFixed(0)}）`)),
      h('div', {}, h('div', { class: 'n' }, ud.jitter.toFixed(1), h('small', {}, ' ms')), h('div', { class: 'l' }, '抖动')),
      h('div', {}, h('div', { class: 'n' }, ud.maxBurst), h('div', { class: 'l' }, '最多连续丢包'))));
    const b3 = h('div', { class: 'card' }, h('h3', {}, 'Hysteria2 / TUIC 建议'));
    if (!ud) b3.append(note('先做一次 UDP 测试（最好也测一下 TCP 速度），这里会根据结果给建议。'));
    else api.call('net:advice', id).then((tips) => {
      for (const t of tips) b3.append(h('div', { style: { margin: '6px 0' } }, h('span', { class: 'tag ' + ({ ok: 'ok', warn: 'warn', bad: 'bad', info: 'blue' }[t.level] || '') }, { ok: '正常', warn: '注意', bad: '问题', info: '建议' }[t.level] || ''), ' ', t.text,
        t.action ? [' ', h('button', { class: 'small', onclick: (e) => run(e.currentTarget, async () => {
          if (t.action === 'antiqos' && !(await confirmBox('给 Hysteria2 开启 salamander 混淆和端口跳跃（20000-30000）？改完会同步到 VPS，用户要刷新订阅。'))) return;
          await api.call('net:fixQuic', id, t.action); toast('已修改并同步，用户刷新订阅即可', 'ok');
        }) }, t.action === 'antiqos' ? '开启混淆 + 端口跳跃' : '改成不限')] : null));
    }).catch((e) => b3.append(h('p', {}, e.message)));
    pane.append(b1, b2, b3);
  }

  // 5. BBR 对比
  function compare() {
    const c = lab().compare;
    const box = h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h3', { style: { margin: 0 } }, 'BBR 和 CUBIC 对比'), h('div', { class: 'spacer' }), c ? h('span', { class: 'muted' }, netAgo(c.at)) : null,
      h('button', { class: c ? '' : 'primary', onclick: (e) => run(e.currentTarget, async () => {
        if (!(await confirmBox('交替切换 BBR 和 CUBIC，各测 3 轮下载（每轮 8 秒），大约 1 分半钟，消耗 VPS 约 200–500MB 流量。测试期间新建的连接会用到正在测的那种算法，测完自动恢复原设置。开始？'))) return;
        await api.call('net:compare', id, 3);
      }) }, c ? '重新对比' : '开始对比')),
      note('两种算法交替测，减少网速随时间波动带来的误差。差距超过 15% 才算明显。只测 TCP（BBR 和 Hysteria2 / TUIC 无关）。'));
    if (c) {
      const row = (k, name) => h('tr', {}, h('td', {}, h('b', {}, name), c.orig === k ? h('span', { class: 'muted' }, '（原设置）') : ''), h('td', {}, fmtMbps(c.sum[k].mbps)), h('td', {}, fmtPct(c.sum[k].retr, 2)), h('td', {}, fmtMs(c.sum[k].ttfb)), h('td', { class: 'muted mono', style: { fontSize: '11px' } }, c[k].map((r) => r.error ? '失败' : r.mbps.toFixed(1)).join(' / ')));
      box.append(h('table', { style: { marginTop: '10px' } }, h('thead', {}, h('tr', {}, ['', '平均速度', '重传率', '首字节', '每轮速度'].map((t) => h('th', {}, t)))), h('tbody', {}, row('bbr', 'BBR'), row('cubic', 'CUBIC'))));
      const ni = lab().info;
      const msg = c.better === 'bbr' ? `BBR 明显更快（快 ${((c.sum.bbr.mbps / Math.max(0.1, c.sum.cubic.mbps) - 1) * 100).toFixed(0)}%），建议启用。` : c.better === 'cubic' ? 'CUBIC 在这条线路上反而更快，建议保持 CUBIC（如果之前开过 BBR，可以在「内核设置」里恢复原始设置）。' : '两者差距不到 15%，在误差范围内。长距离线路一般建议 BBR，晚高峰丢包多时差距会更明显，可以晚上再测一次。';
      box.append(h('p', { style: { marginBottom: 0 } }, h('b', {}, '结论：'), msg, ' ',
        c.better === 'bbr' && ni?.cc !== 'bbr' ? h('button', { class: 'small primary', onclick: (e) => run(e.currentTarget, async () => { const r = await api.call('net:tune', id, ['net.ipv4.tcp_congestion_control', 'net.core.default_qdisc']); toast(r.done?.join('\n') || '已启用', 'ok'); await api.call('net:info', id); }) }, '启用 BBR') : null));
    }
    pane.append(box);
  }

  // 6. 社区测试
  function bench() {
    const reports = S1().benchReports || [];
    const NAMES = { nodequality: 'NodeQuality', tcpquality: 'TcpQuality' };
    const mk = (kind, title, desc, optsEl, getOpts) => {
      const st = h('span', { class: 'muted' }, '');
      const start = h('button', { class: 'primary' }, '开始测试');
      const view = h('button', { class: 'hidden' }, '查看进度');
      const open = () => benchModal(srv, kind, NAMES[kind], () => { if (pane.isConnected && netTab === 'bench') draw(); });
      start.onclick = (e) => busy(e.currentTarget, async () => {
        try {
          st.textContent = '正在 VPS 上启动（缺 curl 会先自动安装）…';
          const r = await api.call('bench:start', id, kind, getOpts());
          st.textContent = r.already ? '已经在运行' : '已启动';
          open();
        } catch (err) { st.textContent = ''; toast('启动失败：' + err.message, 'err'); }
      });
      view.onclick = open;
      // 打开页签时看一眼是不是正在跑（关掉窗口后 VPS 上会继续跑）
      api.call('bench:poll', id, kind, 1e12).then((r) => {
        if (r.none) return;
        if (r.running) { st.textContent = `运行中，已 ${fmtSecs(r.elapsed)}`; view.classList.remove('hidden'); view.classList.add('primary'); start.classList.add('hidden'); }
        else { st.textContent = r.url ? '上次已完成' : '上次已结束'; view.textContent = '查看上次输出'; view.classList.remove('hidden'); }
      }).catch(() => {});
      return h('div', { class: 'card' }, h('h3', {}, title), note(desc), optsEl, h('div', { class: 'toolbar', style: { marginTop: '12px', marginBottom: 0 } }, start, view, st));
    };
    const sel = (opts, v) => { const e = h('select', { class: 'auto' }, opts.map(([k, l]) => h('option', { value: k }, l))); e.value = v; return e; };
    const hq = sel([['f', '快速'], ['y', '标准'], ['n', '跳过']], 'f'); hq.style.width = '96px';
    const nq = sel([['l', '省流量'], ['y', '完整'], ['n', '跳过']], 'l'); nq.style.width = '96px';
    const iq = h('input', { type: 'checkbox', checked: true }); const bt = h('input', { type: 'checkbox', checked: true });
    const tsp = h('input', { type: 'checkbox' }); const tv4 = h('input', { type: 'checkbox', checked: true });
    pane.append(note('这两个是 NodeSeek 社区常用的测试脚本，直接在 VPS 上运行官方脚本，测完给一个可以分享的报告链接。注意：脚本由第三方维护，会以 root 权限在你的 VPS 上运行，只在需要时跑；报告链接是公开的，里面会有这台 VPS 的 IP。'),
      mk('nodequality', 'NodeQuality（综合：硬件、IP 质量、网络质量、回程）', '大约 5–15 分钟。完整网络测试会跑多地测速、用掉较多流量，小流量机器选「省流量」。', h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '18px', alignItems: 'center' } }, h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, '硬件测试', hq), h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, '网络测试', nq), h('label', {}, iq, ' IP 质量'), h('label', {}, bt, ' 回程路由')),
        () => ({ hq: hq.value, nq: nq.value, iq: iq.checked ? 'y' : 'n', bt: bt.checked ? 'y' : 'n' })),
      mk('tcpquality', 'TcpQuality（国内各省三网回程丢包、大包重传）', '大约 3–8 分钟，从国内多个省份的节点测到这台 VPS 的丢包和延迟。', h('div', { style: { display: 'flex', gap: '18px' } }, h('label', {}, tv4, ' 只测 IPv4'), h('label', {}, tsp, ' 加测单线程速度（多用流量）')),
        () => ({ speedtest: tsp.checked, v4: tv4.checked })));
    if (reports.length) pane.append(h('div', { class: 'card' }, h('h3', {}, '历史报告'), h('table', {}, h('tbody', {}, reports.map((r) => h('tr', {}, h('td', {}, r.kind === 'nodequality' ? 'NodeQuality' : 'TcpQuality'), h('td', { class: 'muted' }, fmtDate(r.at)),
      h('td', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.call('open:external', r.url); } }, r.url)), h('td', {}, h('button', { class: 'small', onclick: () => copy(r.url) }, '复制'))))))));
  }

  draw();
  modal({ title: `网络优化 · ${srv.name}`, wide: true, body, onClose: () => { off(); stopPolls(); }, buttons: [{ label: '关闭' }] });
}

function fmtSecs(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return sec >= 3600 ? `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分` : sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
}

// 简单的终端：\r 回到行首覆盖（进度条原地刷新），\n 换行
function termFeed(t, chunk) {
  for (const part of String(chunk).split(/(\n|\r)/)) {
    if (part === '\n') { t.lines.push(''); t.cr = false; } else if (part === '\r') t.cr = true;
    else if (part) { if (t.cr) { t.lines[t.lines.length - 1] = ''; t.cr = false; } t.lines[t.lines.length - 1] += part; }
  }
  if (t.lines.length > 4000) t.lines.splice(0, t.lines.length - 4000);
}

// 社区测试的运行窗口：实时输出、用时、停止、完成后打开报告。关掉窗口 VPS 上会继续跑
function benchModal(srv, kind, name, onClosed) {
  const id = srv.id;
  const term = { lines: [''], cr: false };
  let offset = 0; let alive = true; let timer = null; let elapsed = 0; let lastTick = Date.now(); let running = true;
  const pill = h('span', { class: 'tag' }, '连接中…');
  const clock = h('span', { class: 'muted' }, '');
  const pre = h('pre', { class: 'term' }, '');
  const reportBox = h('div', { class: 'bench-report hidden' });
  const stopBtn = h('button', { class: 'danger' }, '停止测试');
  const hint = h('div', { class: 'muted', style: { fontSize: '12px' } }, '关掉这个窗口不影响测试，VPS 上会继续跑，回到「社区测试」可以再打开');
  const body = h('div', {}, h('div', { class: 'toolbar', style: { marginBottom: '10px' } }, pill, clock, h('div', { class: 'spacer' }), hint), reportBox, pre);
  const showReport = (url) => {
    reportBox.innerHTML = '';
    reportBox.classList.remove('hidden');
    reportBox.append(h('div', { style: { flex: 1, minWidth: 0 } }, h('b', {}, '测试完成，报告已生成'), h('div', { class: 'mono', style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' } }, url)),
      h('button', { class: 'small primary', onclick: () => api.call('open:external', url) }, '打开报告'), h('button', { class: 'small', onclick: () => copy(url) }, '复制链接'));
  };
  const setState = (r) => {
    running = r.running;
    pill.className = 'tag ' + (r.running ? 'blue' : r.url ? 'ok' : 'warn');
    pill.textContent = r.running ? '运行中' : r.url ? '已完成' : '已结束';
    stopBtn.classList.toggle('hidden', !r.running);
    elapsed = r.elapsed || elapsed; lastTick = Date.now();
    if (r.url) showReport(r.url);
  };
  const paintClock = () => { clock.textContent = (running ? '已用时 ' : '用时 ') + fmtSecs(elapsed + (running ? (Date.now() - lastTick) / 1000 : 0)); };
  const clockTimer = setInterval(paintClock, 1000);
  const step = async () => {
    if (!alive) return;
    try {
      const r = await api.call('bench:poll', id, kind, offset);
      if (!alive) return;
      if (r.none) { pill.textContent = '没有找到测试'; running = false; return; }
      if (r.text) {
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        termFeed(term, r.text);
        pre.textContent = term.lines.join('\n');
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }
      offset = r.size;
      setState(r); paintClock();
      if (r.running) timer = setTimeout(step, 2500);
    } catch (e) {
      if (!alive) return;
      pill.className = 'tag bad'; pill.textContent = '读取失败';
      hint.textContent = e.message + '（5 秒后重试）';
      timer = setTimeout(step, 5000);
    }
  };
  stopBtn.onclick = (e) => busy(e.currentTarget, async () => {
    if (!(await confirmBox(`停止 ${name} 测试？已经跑的部分不会生成报告。`, '停止'))) return;
    await api.call('bench:stop', id, kind);
    toast('已停止', 'ok');
    clearTimeout(timer); setTimeout(step, 1500);
  });
  modal({ title: `${name} · ${srv.name}`, wide: true, body, onClose: () => { alive = false; clearTimeout(timer); clearInterval(clockTimer); onClosed && onClosed(); },
    buttons: [{ label: '停止测试', class: 'danger', close: false, el: stopBtn }, { label: '关闭' }] });
  // 用自己的停止按钮替换 footer 里的占位
  const footBtn = [...document.querySelectorAll('.modal footer button')].reverse().find((b) => b.textContent === '停止测试');
  if (footBtn) footBtn.replaceWith(stopBtn);
  step();
}

// 清理 VPS 上以前装的其他面板 / 代理程序（不重装系统）。默认彻底删除；勾选备份时整套打包，之后可以一键恢复
async function cleanOthers(s) {
  const body = h('div', {});
  const logBox = h('pre', { class: 'log hidden', style: { maxHeight: '220px', marginTop: '10px' } });
  const off = api.on('task-log', (m) => { if (m.task !== 'clean:' + s.id) return; logBox.classList.remove('hidden'); logBox.textContent += m.line + '\n'; logBox.scrollTop = logBox.scrollHeight; });
  const goBtn = h('button', { class: 'danger', disabled: true }, '删除选中的');
  const bakCb = h('input', { type: 'checkbox' }); // 默认不备份，彻底删干净
  const ourPorts = new Set(Object.entries(s.protocols || {}).filter(([, p]) => p?.enabled).map(([, p]) => Number(p.port)));
  const mbText = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + 'GB' : Math.max(1, Math.round(mb)) + 'MB');
  let picks = [];
  let update = () => {};
  let busyNow = false;
  const runTask = async (fn) => {
    if (busyNow) return;
    busyNow = true; logBox.textContent = '';
    try { await fn(); } catch (e) { toast(e.message, 'err'); }
    busyNow = false;
    const keepLog = logBox.textContent;
    setTimeout(async () => { await scan(); if (keepLog) { logBox.textContent = keepLog; logBox.classList.remove('hidden'); } }, 0);
  };
  const scan = async () => {
    body.innerHTML = '';
    body.append(h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' 正在扫描 VPS 上的面板、代理程序、Docker 容器和占用端口的程序…'));
    goBtn.disabled = true;
    let r;
    try { r = await api.call('server:scanOthers', s.id); } catch (e) { body.innerHTML = ''; body.append(h('p', {}, h('span', { class: 'tag bad' }, '扫描失败'), ' ', e.message)); return; }
    body.innerHTML = '';
    picks = [];
    update = () => {
      const sel = picks.filter((p) => p.cb.checked);
      goBtn.disabled = !sel.length || busyNow;
      goBtn.textContent = sel.length ? `删除选中的（${sel.length}）` : '删除选中的';
      const canBak = sel.some((p) => p.it.kind === 'app' || p.it.kind === 'docker');
      bakRow.classList.toggle('hidden', !canBak);
    };
    const conflict = (ports) => ports.map((p) => Number(String(p).split('/')[0])).filter((p) => ourPorts.has(p));
    const portTags = (ports) => ports.map((p) => { const bad = conflict([p]).length; return h('span', { class: 'tag ' + (bad ? 'bad' : ''), title: bad ? '和 NodeDeck 的节点端口冲突' : '' }, p); });
    const item = (it, checked, title, sub, extra) => {
      const cb = h('input', { type: 'checkbox', checked });
      cb.onchange = update;
      picks.push({ cb, it });
      return h('label', { class: 'cl-item' }, cb, h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'cl-title' }, title), sub ? h('div', { class: 'muted cl-sub' }, sub) : null, extra));
    };
    const section = (t, desc, rows) => rows.length ? h('div', { class: 'cl-sec' }, h('h4', {}, t), desc ? h('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 6px' } }, desc) : null, rows) : null;
    const apps = r.apps.map((a) => item({ kind: 'app', id: a.id, ports: a.ports }, true,
      h('span', {}, h('b', {}, a.name), ' ', h('span', { class: 'tag ' + (a.running ? 'warn' : '') }, a.running ? '运行中' : '没在运行'), a.mb ? h('span', { class: 'tag' }, mbText(a.mb)) : null, conflict(a.ports).length ? h('span', { class: 'tag bad' }, '占用了节点端口') : null),
      [a.units.length ? '服务 ' + a.units.map((u) => u.name).join('、') : '', a.paths.length ? '目录 ' + a.paths.map((x) => `${x.path}${x.mb > 1 ? `（${mbText(x.mb)}）` : ''}`).join('、') : ''].filter(Boolean).join(' · '),
      h('div', {}, a.ports.length ? h('span', { class: 'muted', style: { fontSize: '12px' } }, '端口 ', portTags(a.ports)) : null, a.danger ? h('div', { class: 'cl-danger' }, '⚠ ' + a.danger) : null)));
    const docks = r.containers.map((c) => item({ kind: 'docker', id: c.id, name: c.name, image: c.image }, false, h('span', {}, h('b', {}, c.name), ' ', h('span', { class: 'tag ' + (c.running ? 'warn' : '') }, c.running ? '运行中' : '已停止')), `镜像 ${c.image}${c.ports ? ' · ' + c.ports : ''}`));
    const others = r.others.map((o) => o.unit
      ? item({ kind: 'other', unit: o.unit }, false, h('span', {}, h('b', {}, o.unit), ' ', conflict(o.ports).length ? h('span', { class: 'tag bad' }, '占用了节点端口') : null), `${o.exe || o.cmd}`, h('div', {}, h('span', { class: 'muted', style: { fontSize: '12px' } }, '端口 ', portTags(o.ports)), h('div', { class: 'muted', style: { fontSize: '12px' } }, '只停止这个服务、取消开机自启，不删除程序文件')))
      : h('div', { class: 'cl-item' }, h('span', { style: { width: '16px' } }), h('div', {}, h('b', {}, o.name), ' ', h('span', { class: 'muted', style: { fontSize: '12px' } }, o.cmd || o.exe), h('div', {}, portTags(o.ports), h('span', { class: 'muted', style: { fontSize: '12px' } }, ' 不是系统服务，NodeDeck 不处理，可以 SSH 登录后自己看')))));
    const olds = r.oldBackups.length ? [item({ kind: 'oldBackups' }, true, h('b', {}, `旧版留下的配置备份（${r.oldBackups.length} 个）`), r.oldBackups.map((b) => b.path).join('、'))] : [];
    // 可以恢复的备份
    const bks = r.backups.map((b) => h('div', { class: 'cl-item cl-bk' },
      h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'cl-title' }, h('b', {}, [...(b.apps || []).map((x) => x.name), ...(b.containers || []).map((x) => (/容器/.test(x) ? x : '容器 ' + x))].join('、') || '备份'), h('span', { class: 'tag' }, mbText(b.kb / 1024))), h('div', { class: 'muted cl-sub' }, `${fmtDate(b.at)} · /root/nodedeck-backup/${b.id}`)),
      h('button', { class: 'small primary', onclick: async () => {
        let plan;
        toast('正在检查端口…');
        try { plan = await api.call('server:restorePlan', s.id, b.id); } catch (e) { toast(e.message, 'err'); return; }
        const what = [...plan.apps, ...plan.containers.map((x) => '容器 ' + x)].join('、');
        const lines = [`把「${what}」恢复回去？程序、配置、数据和服务会放回原来的位置并启动。`];
        if (plan.needDocker) lines.push('', 'VPS 上没有 Docker，会先自动安装（官方脚本）。');
        if (plan.moves.length) lines.push('', '端口冲突会这样处理：', ...plan.moves.map((m) => `• ${m.who} 要用 ${m.from}，NodeDeck 的 ${m.label} 改到 ${m.to} 并同步（用户需要刷新订阅）`));
        if (plan.remapList.length) lines.push('', ...plan.remapList.map((x) => `• 容器 ${x.name} 的 ${x.from}/${x.proto} 被占用，改用空闲端口 ${x.to}`));
        if (plan.warnings.length) lines.push('', '⚠ ' + plan.warnings.join('\n⚠ '));
        if (!plan.moves.length && !plan.remapList.length && !plan.warnings.length) lines.push('', '端口检查：没有冲突。');
        if (!(await confirmBox(lines.join('\n'), '恢复'))) return;
        await runTask(async () => {
          const r = await api.call('server:restoreBackup', s.id, b.id, plan);
          const notes = [...r.moves.map((m) => `${m.label} 端口改成了 ${m.to}`), ...r.remapList.map((x) => `容器 ${x.name} 改用端口 ${x.to}`)];
          toast('已恢复' + (notes.length ? '：' + notes.join('；') + (r.moves.length ? '。用户需要刷新订阅' : '') : ''), 'ok');
          await reload();
        });
      } }, '一键恢复'),
      h('button', { class: 'small danger', onclick: async () => {
        if (!(await confirmBox(`删除这份备份？删除后就不能恢复了。`, '删除'))) return;
        await runTask(async () => { await api.call('server:deleteBackup', s.id, b.id); toast('备份已删除', 'ok'); });
      } }, '删除')));
    const bakRow = h('label', { class: 'f cl-bakrow' }, bakCb, ' 删除前整套备份（程序、配置、服务文件、定时任务、容器和它的数据），以后可以在这里一键恢复。默认不备份，彻底删干净');
    if (!apps.length && !docks.length && !others.length && !olds.length) {
      body.append(h('div', { class: 'cl-empty' }, h('b', {}, '很干净'), h('p', { class: 'muted' }, '没有发现其他面板、代理程序、Docker 容器，也没有别的程序占用公网端口。')));
    } else {
      body.append(
        h('div', { class: 'cl-warn' }, '默认是彻底删除，不能恢复；需要留后路就勾选下面的「删除前整套备份」。SSH、系统服务和 NodeDeck 自己的东西不会动。'),
        section('面板 / 代理程序', '停止服务、取消开机自启，删除它的程序、配置、服务文件和定时任务。', apps),
        section('Docker 容器', '默认不勾。勾上的容器连同它的数据卷和镜像一起删除（还被别的容器用着的保留）。勾了「整套备份」的话，容器的配置、数据卷、挂载目录和本地镜像也会备份，可以一键重新装回来。', docks),
        section('其他占用公网端口的程序', '不认识的程序默认不勾，只停用不删除。', others),
        section('旧备份', '', olds),
        bakRow);
    }
    if (bks.length) body.append(h('div', { class: 'cl-sec', style: { marginTop: '16px' } }, h('h4', {}, '备份（可以一键恢复）'), h('p', { class: 'muted', style: { fontSize: '12px', margin: '0 0 6px' } }, '保存在 VPS 的 /root/nodedeck-backup 里。确定不需要了可以删掉，省磁盘空间。'), bks));
    body.append(logBox);
    update();
  };
  goBtn.onclick = async () => {
    const sel = picks.filter((p) => p.cb.checked).map((p) => p.it);
    if (!sel.length) return;
    const big = picks.filter((p) => p.cb.checked && p.it.kind === 'app' && ['bt', '1panel'].includes(p.it.id)).length;
    const msg = `确定处理选中的 ${sel.length} 项？\n\n${bakCb.checked ? '会先整套备份，以后可以一键恢复。' : '会彻底删除，不留备份，不能恢复。'}${big ? '\n\n⚠ 选中了宝塔 / 1Panel：它们下面的网站文件和数据库也会一起删除。' : ''}`;
    if (!(await confirmBox(msg, '删除'))) return;
    goBtn.disabled = true;
    await runTask(async () => {
      const r = await api.call('server:cleanOthers', s.id, sel, { backup: bakCb.checked });
      toast(r.backup ? `清理完成，备份在 ${r.backup}，可以在这里一键恢复` : '清理完成', 'ok');
    });
  };
  modal({ title: `清理其他面板 / 程序 · ${s.name}`, wide: true, body, onClose: off, buttons: [{ label: '重新扫描', close: false, onClick: () => scan() }, { label: '删除选中的', close: false }, { label: '关闭' }] });
  const ph = [...document.querySelectorAll('.modal footer button')].reverse().find((b) => b.textContent === '删除选中的' && b !== goBtn);
  if (ph) ph.replaceWith(goBtn);
  scan();
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

// 删除 / 卸载服务器：可以全部卸载，也可以只勾部分
const UNINSTALL_ITEMS = [
  ['svc', '节点服务、agent 和全部数据', 'sing-box、Xray、Cloudflare 隧道、agent 停掉并删除，/etc/nodedeck 里的配置、证书、流量统计都删掉。不勾的话节点继续运行'],
  ['sys', '还原系统设置', '跳跃端口规则、DNS、网络优化参数、NodeDeck 加的 swap 和系统日志大小限制，恢复成部署前（有备份的才还原）'],
  ['fw', '关掉 NodeDeck 放行的防火墙端口', '只关 NodeDeck 新放行的端口；更早部署、没有记录的，只关现在没有程序在用的。SSH 端口永远不关'],
  ['cd', 'changedetection.io（补货提醒）', '装在这台上的话，删掉它的容器、数据和镜像。Docker 本身保留（别的程序可能在用）'],
];

function uninstallServer(s, removeRecord) {
  const boxes = Object.fromEntries(UNINSTALL_ITEMS.map(([k]) => [k, h('input', { type: 'checkbox', checked: k !== 'cd' || S.settings.cd?.serverId === s.id })]));
  const all = h('input', { type: 'checkbox' });
  const syncAll = () => { const v = Object.values(boxes); all.checked = v.every((b) => b.checked); all.indeterminate = !all.checked && v.some((b) => b.checked); };
  all.onchange = () => { for (const b of Object.values(boxes)) b.checked = all.checked; };
  for (const b of Object.values(boxes)) b.addEventListener('change', syncAll);
  syncAll();
  const rec = h('input', { type: 'checkbox', checked: !!removeRecord });
  modal({ title: `${removeRecord ? '删除' : '卸载'}「${s.name}」`, body: h('div', {},
    h('p', { class: 'muted', style: { marginTop: 0 } }, '勾选要从服务器上清理的内容：'),
    h('div', { class: 'un-list' },
      chk(all, '全部'),
      h('div', { class: 'un-items' }, UNINSTALL_ITEMS.map(([k, t, d]) => chk(boxes[k], t, d)))),
    h('div', { class: 'un-rec' }, chk(rec, '同时从软件里删除这台服务器', '指向这台、或以这台做中转的中转 / 端口转发规则，和用户线路里的这台都会一起去掉')),
    ), buttons: [
    { label: '取消' },
    { label: removeRecord ? '卸载并删除' : '卸载', class: 'danger', onClick: async () => {
      const parts = Object.entries(boxes).filter(([, b]) => b.checked).map(([k]) => k);
      if (!parts.length && !rec.checked) throw new Error('什么都没勾');
      if (parts.length) {
        try {
          const log = await api.call('server:uninstall', s.id, parts);
          const closed = String(log || '').split('\n').filter((l) => l.startsWith('  关闭 ')).map((l) => l.trim().slice(3));
          toast((parts.includes('svc') ? '已从服务器上卸载' : '已清理所选内容') + (closed.length ? `\n关掉了防火墙端口：${closed.join('、')}` : ''), 'ok');
        } catch (e) {
          if (!rec.checked || !(await confirmBox(`服务器上的清理失败：${e.message}\n\n还要从软件里删除这台吗？（服务器上的东西会留着）`, '仍然删除'))) throw e;
        }
      }
      if (rec.checked) { await api.call('col:remove', 'servers', s.id); markDirty(); }
      render();
    } },
  ] });
}

async function removeServer(s) {
  if (s.deployedAt) { uninstallServer(s, true); return; }
  if (await confirmBox(`删除「${s.name}」？\n\n这台还没部署，只会删掉软件里的记录。`, '删除')) { await api.call('col:remove', 'servers', s.id); markDirty(); render(); }
}
