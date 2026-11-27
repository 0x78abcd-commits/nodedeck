'use strict';
/* global api, h, toast, modal, confirmBox, field, copy, fmtBytes, fmtDate, busy */
// 由 index.html 按顺序加载：ui.js → app.js → servers.js → netopt.js → nodes.js → users.js → landings.js → toolbox.js → stock.js → settings.js（最后一个启动界面）

// ---------- 设置 ----------
function updateCard() {
  const st = updateStatus;
  const card = h('div', { class: 'card' }, h('h3', {}, '软件更新'));
  const text = {
    idle: '尚未检查', checking: '正在检查…', latest: `已是最新版本（${st.latest || info.version}）`, available: `发现新版本 ${st.latest}`,
    downloading: `正在下载新版本 ${st.latest || ''}`, downloaded: `新版本 ${st.latest} 已下载，重启时自动安装（不弹安装窗口）`, error: '检查失败：' + (st.error || ''), dev: '开发模式不检查更新',
  }[st.state || 'idle'];
  card.append(h('p', {}, `当前版本 v${info.version}${info.portable ? '（便携版）' : ''}`), h('p', { class: st.state === 'error' ? 'muted' : '' }, text));
  if (st.state === 'downloading') card.append(updProgress(st));
  const acts = h('div', { class: 'actions' }, h('button', { onclick: (e) => busy(e.currentTarget, () => api.call('update:check')) }, '检查更新'));
  if (st.state === 'available') acts.append(h('button', { class: 'primary', onclick: () => api.call('update:download') }, info.portable ? '下载新版便携包' : '立即更新'));
  if (st.state === 'downloaded') acts.append(h('button', { class: 'primary', onclick: () => api.call('update:install') }, '重启并安装'));
  card.append(acts, h('p', { class: 'muted', style: { marginTop: '10px' } }, '启动 10 秒后自动检查，之后每 30 分钟检查一次。更新从 GitHub 下载，国内需要先开代理。'));
  return card;
}

// 探针网页：主控 VPS 在订阅端口出一个只读状态页
function probeCard() {
  const card = h('div', { class: 'card' }, h('h3', {}, '探针网页'), h('p', { class: 'muted' }, '加载中…'));
  const draw = (info) => {
    const p = S.settings.probe || {};
    const deployed = S.servers.filter((x) => x.deployedAt);
    const on = h('input', { type: 'checkbox', checked: !!p.enabled });
    const host = h('select', {}, deployed.map((x) => h('option', { value: x.id }, x.name)));
    host.value = p.hostId || deployed[0]?.id || '';
    const title = h('input', { value: p.title || '服务器状态', maxlength: 40 });
    const alert = h('input', { type: 'checkbox', checked: p.alert !== false });
    const hidden = new Set(p.hidden || []);
    const shows = deployed.map((x) => { const c = h('input', { type: 'checkbox', checked: !hidden.has(x.id) }); c.dataset.id = x.id; return h('label', { class: 'chip', style: { cursor: 'pointer' } }, c, ' ', x.name); });
    const collect = () => ({ enabled: on.checked, hostId: host.value, title: title.value.trim() || '服务器状态', alert: alert.checked, hidden: shows.map((l) => l.querySelector('input')).filter((c) => !c.checked).map((c) => c.dataset.id) });
    const save = (extra = {}) => async (e) => busy(e.currentTarget, async () => {
      if (on.checked && !host.value) throw new Error('先部署一台服务器当主控');
      const r = await api.call('probe:save', { ...collect(), ...extra });
      await reload();
      const bad = r.results.filter((x) => !x.ok);
      toast(bad.length ? `已保存，但这些服务器同步失败：${bad.map((x) => `${x.name}（${x.error}）`).join('；')}` : (r.info.on ? '探针已更新' : '已关闭探针'), bad.length ? 'err' : 'ok');
      draw(r.info);
    });
    const peerRows = (info.peers || []).map((x) => h('span', { class: 'tag ' + (x.online === undefined ? '' : x.online ? 'ok' : 'bad'), title: x.error || '' }, x.name + (x.online === false ? '：连不上' : '')));
    card.replaceChildren(h('h3', {}, '探针网页'),
      h('p', { class: 'muted' }, '选一台服务器当主控，它会每 5 秒收集所有服务器的 CPU、内存、磁盘、网速、本月流量和到期时间，在订阅端口上出一个网页，手机浏览器打开就能看。只读：网页里不显示 IP，也没有任何远程操作功能。'),
      chk(on, '开启'),
      h('div', { class: 'row' }, field('主控服务器', host, '这台要一直开着；它自己宕机时没法发告警'), field('网页标题', title)),
      chk(alert, '服务器离线 1 分钟 / 恢复时发通知', info.notifyOn ? `发到 ${info.channels.join(' / ')}` : '先在「通知」页配好 Telegram 或微信'),
      field('网页上显示的服务器', h('div', { class: 'chips', style: { flexWrap: 'wrap' } }, shows.length ? shows : h('span', { class: 'muted' }, '还没有已部署的服务器'))),
      info.on ? h('div', { style: { margin: '10px 0' } },
        h('div', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '12px' } }, info.url),
        !info.https ? h('div', { class: 'muted', style: { fontSize: '12px' } }, '主控的订阅 HTTPS 证书还没申请下来，链接暂时是 http（证书好了以后链接自动变成 https，要重新复制）') : null,
        info.stale ? h('div', { style: { fontSize: '12px', color: 'var(--warn)' } }, '服务器有增减或改名，主控上的列表还没更新，点「保存并同步」') : null,
        peerRows.length ? h('div', { class: 'chips', style: { flexWrap: 'wrap', marginTop: '6px' } }, peerRows) : null,
        !S.settings.latencyProbe ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, '想在探针里看三网延迟：在', h('a', { href: '#', onclick: (e) => { e.preventDefault(); goSettings('guard'); } }, '「巡检与告警」'), '里打开「后台记录三网延迟和丢包」') : null) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onclick: save() }, '保存并同步'),
        info.on ? h('button', { onclick: () => api.call('open:external', info.url) }, '打开') : null,
        info.on ? h('button', { onclick: () => copy(info.url) }, '复制链接') : null,
        info.on ? h('button', { onclick: () => showQr('探针网页', info.url, '用手机相机或浏览器扫码打开') }, '二维码') : null,
        info.on ? h('button', { onclick: async (e) => { const b = e.currentTarget; if (await confirmBox('换一个新链接？旧链接马上失效，发给别人的要重新发。')) save({ newLink: true })({ currentTarget: b }); } }, '换个链接') : null));
  };
  api.call('probe:info').then(draw).catch((e) => card.replaceChildren(h('h3', {}, '探针网页'), h('p', { class: 'muted' }, e.message)));
  return card;
}

// 勾选项：标题一行，说明另起一行小字
function chk(input, title, desc) {
  return h('label', { class: 'chk' }, input, h('div', {}, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null));
}

const SET_TABS = [['notify', '通知'], ['guard', '巡检与告警'], ['probe', '探针网页'], ['server', '服务器与内核'], ['conn', '连接与备份'], ['app', '外观与更新']];
let setTab = 'notify';
function goSettings(tab) { setTab = tab; go('settings'); }

async function viewSettings(v) {
  await reload();
  const st = S.settings;
  const saved = (msg = '已保存，点「同步全部」后各服务器生效') => { toast(msg, 'ok'); markDirty(); };

  // ---- 通知 ----
  const tg = st.telegram || {};
  const tgOn = h('input', { type: 'checkbox', checked: !!tg.enabled });
  const tgToken = h('input', { value: tg.botToken || '', placeholder: '找 @BotFather 创建机器人获得' });
  const tgChat = h('input', { value: tg.chatId || '', placeholder: '找 @userinfobot 获得' });
  const tgDaily = h('input', { type: 'checkbox', checked: tg.daily !== false });
  const tgHour = h('input', { type: 'number', min: 0, max: 23, value: tg.dailyHour ?? 9 });
  const tgDays = h('input', { type: 'number', min: 0, value: tg.warnDays ?? 3 });
  const tgPct = h('input', { type: 'number', min: 0, max: 100, value: tg.warnPercent ?? 90 });
  const tgServer = h('select', { style: { width: 'auto', maxWidth: '200px' } }, S.servers.filter((x) => x.deployedAt).map((x) => h('option', { value: x.id }, x.name)));
  const wx = st.wechat || {};
  const wxPP = h('input', { value: wx.pushplus || '', placeholder: '32 位 token', class: 'mono' });
  const wxSC = h('input', { value: wx.serverchan || '', placeholder: 'SCT 开头的 SendKey', class: 'mono' });
  const saveTg = async () => {
    await api.call('settings:set', { telegram: { enabled: tgOn.checked, botToken: tgToken.value.trim(), chatId: tgChat.value.trim(), daily: tgDaily.checked, dailyHour: Number(tgHour.value) || 0, warnDays: Number(tgDays.value) || 0, warnPercent: Number(tgPct.value) || 0 },
      wechat: { pushplus: wxPP.value.trim(), serverchan: wxSC.value.trim() } });
  };
  const chanNames = () => [tgOn.checked && tgToken.value.trim() && tgChat.value.trim() && 'Telegram', wxSC.value.trim() && 'Server 酱', wxPP.value.trim() && 'PushPlus'].filter(Boolean);
  const chanTag = (on) => h('span', { class: 'tag ' + (on ? 'ok' : ''), style: { marginLeft: '8px', fontWeight: 400 } }, on ? '已配置' : '未配置');
  const tgPane = () => h('div', {},
    h('p', { class: 'muted set-lead' }, '通知由各台 VPS 上的 agent 直接发送，电脑关机也能收到。下面的渠道配了哪个就发哪个，可以同时开。'),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h3', {}, 'Telegram', chanTag(tg.enabled && tg.botToken && tg.chatId)),
        chk(tgOn, '开启'),
        field('机器人 Token', tgToken), field('接收消息的 Chat ID', tgChat)),
      h('div', { class: 'card' }, h('h3', {}, '微信', chanTag(wx.pushplus || wx.serverchan)),
        h('p', { class: 'muted', style: { marginTop: 0 } }, '国内手机不用开代理就能收到。'),
        field('PushPlus token（推荐）', wxPP, '在 pushplus.plus 用微信扫码登录、关注公众号，「一对一推送」里复制'),
        field('Server 酱 SendKey', wxSC, '在 sct.ftqq.com 用微信扫码登录，「SendKey」页复制。免费版每天条数有限；Server 酱³（sctp 开头）推到它自己的 App，也能填'))),
    h('div', { class: 'card' }, h('h3', {}, '提醒内容'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, '用户快到期 / 流量快用完 / 被停用、内核升级结果、运维告警、探针离线、补货提醒都会发；下面几项可以调。'),
      chk(tgDaily, '每日流量报告'),
      h('div', { class: 'row' }, field('日报时间（几点）', tgHour), field('提前几天提醒到期', tgDays), field('流量用到百分之几提醒', tgPct))),
    h('div', { class: 'actions set-foot' },
      h('button', { class: 'primary', onclick: async () => { await saveTg(); saved(); } }, '保存'),
      tgServer.options.length ? h('span', { class: 'muted', style: { marginLeft: '8px' } }, '测试：') : null,
      tgServer.options.length ? tgServer : null,
      tgServer.options.length ? h('button', { onclick: (e) => busy(e.currentTarget, async () => { const ch = chanNames(); if (!ch.length) { toast('先填一个渠道', 'err'); return; } await saveTg(); await api.call('server:sync', tgServer.value); await api.call('telegram:test', tgServer.value); toast(`测试消息已发送，去 ${ch.join(' / ')} 看看`, 'ok'); }) }, '从这台服务器发测试消息') : h('span', { class: 'muted' }, '部署服务器后可以发测试消息')));

  // ---- 巡检与告警 ----
  const sel = (opts, val) => { const e = h('select', {}, opts.map(([k, l]) => h('option', { value: k }, l))); e.value = val; return e; };
  const guardPane = () => {
    const rpMode = sel([['auto', '自动换新目标并通知'], ['notify', '只通知'], ['off', '不检查']], st.realityPatrol || 'auto');
    const bwMode = sel([['off', '关闭'], ['notify', '只提醒'], ['auto', '自动一键换新（6 小时内最多一次）并提醒']], st.blockWatch || 'off');
    const bcVia = sel([['peers', '用我自己的其它 VPS 互相检测（不联系第三方）'], ['checkhost', '用 check-host.net 多地检测（第三方，只在手动检测时用）']], st.blockCheckVia === 'checkhost' ? 'checkhost' : 'peers');
    const bwHint = h('div', { class: 'muted', style: { fontSize: '12px', margin: '-6px 0 12px' } });
    const syncBc = () => {
      const ch = bcVia.value === 'checkhost';
      bwMode.disabled = ch;
      bwHint.textContent = ch ? '用 check-host.net 时不做自动巡检：只有你在工具箱、体检里手动检测时才会把 IP 和端口发给它' : (S.servers.filter((x) => x.deployedAt).length < 2 ? '只有一台服务器时没有别的 VPS 能帮忙检测，巡检只能看本机通不通' : '');
    };
    bcVia.onchange = syncBc;
    syncBc();
    const al = st.alerts || {};
    const alOn = h('input', { type: 'checkbox', checked: al.enabled !== false });
    const tuneOn = h('input', { type: 'checkbox', checked: st.smallBoxTuning !== false });
    const netOn = h('input', { type: 'checkbox', checked: st.netAutoTune !== false });
    const probeOn = h('input', { type: 'checkbox', checked: !!st.latencyProbe });
    const trackOn = h('input', { type: 'checkbox', checked: st.onlineTrack !== false });
    const alDisk = h('input', { type: 'number', min: 50, max: 99, value: al.diskPct || 90 });
    const alCpu = h('input', { type: 'number', min: 50, max: 100, value: al.cpuPct || 90 });
    const alLat = h('input', { type: 'number', min: 50, value: al.latencyMs || 300 });
    return h('div', {},
      h('div', { class: 'card' }, h('h3', {}, '自动巡检'),
        field('Reality 目标巡检（VPS 每 6 小时检查一次）', rpMode, '目标网站下线、证书过期或不再支持 TLS 1.3 / HTTP2 时节点会连不上。自动模式下连续 3 次失败会换成同网段邻居或最快的大站，并改好本机订阅'),
        field('被墙检测用什么当「海外视角」', bcVia, '判断被墙要对比：你这里连不通、外面能连通。自己的 VPS 互查不会把 IP 发给任何第三方，但至少要两台已部署的服务器；check-host.net 节点多、只有一台服务器也能用，但会把 IP 和端口发给它'),
        field('被墙巡检（软件开着时每 30 分钟查一次）', bwMode, '本机连不通、海外视角能通，连续两次才判定被墙；电脑网络断了不会误报。关闭时可以在「工具箱 → 被墙检测」或服务器「体检」里手动查'), bwHint),
      h('div', { class: 'card' }, h('h3', {}, '运维告警'),
        chk(alOn, '开启运维告警', 'sing-box 挂了（会先自动重启）、磁盘快满、CPU 持续过高、三网延迟变差时，发到「通知」里配的渠道'),
        h('div', { class: 'row' }, field('磁盘用到 %', alDisk), field('CPU 连续 15 分钟高于 %', alCpu), field('三网延迟高于 ms', alLat))),
      h('div', { class: 'card' }, h('h3', {}, '后台任务与部署优化'),
        chk(trackOn, '统计每个用户在用几台设备', '用户列表的「在用」显示最近 10 分钟连过的不同来源 IP 数。VPS 上的代理内核把连接记录写到一个临时文件，agent 每 15 秒读一次就清空，只留来源 IP 和时间，不记访问了哪些网站。按 IP 算：同一个 Wi-Fi 下的几台设备算 1 台'),
        chk(probeOn, '后台记录三网延迟和丢包', 'VPS 每 5 分钟往国内三网各发 10 个 ping（每台每月几十 MB 流量）。打开后监控面板的延迟曲线、「网络优化」的晚高峰对比、延迟告警和探针里的三网延迟才有数据。默认关'),
        chk(netOn, '部署时自动做其它网络优化', '检测后只改有依据的几项（缓冲区、路径 MTU 探测）；BBR + fq 部署时总会开启。原值都会备份，在服务器「更多 → 网络优化」里可以恢复'),
        chk(tuneOn, '小配置 VPS 自动优化', '内存 ≤ 2GB 且没有 swap 时加一个 swap 文件（1GB 内存加 1GB，2GB 加 2GB，磁盘不够会减小或跳过）；磁盘 < 20GB 时把系统日志限制在 200MB。卸载时一并撤销')),
      h('div', { class: 'actions set-foot' }, h('button', { class: 'primary', onclick: async () => {
        await api.call('settings:set', { blockCheckVia: bcVia.value, onlineTrack: trackOn.checked, latencyProbe: probeOn.checked, netAutoTune: netOn.checked, smallBoxTuning: tuneOn.checked, realityPatrol: rpMode.value, blockWatch: bwMode.value, alerts: { enabled: alOn.checked, diskPct: Number(alDisk.value) || 90, cpuPct: Number(alCpu.value) || 90, latencyMs: Number(alLat.value) || 300 } });
        saved();
      } }, '保存')));
  };

  // ---- 服务器与内核 ----
  const serverPane = () => {
    const subPort = h('input', { type: 'number', value: st.subPort });
    const statsPort = h('input', { type: 'number', value: st.statsPort });
    const adminPort = h('input', { type: 'number', value: st.adminPort });
    const sbBase = h('input', { value: st.singboxBase });
    const xrBase = h('input', { value: st.xrayBase || '', placeholder: '留空 = 和 sing-box 同一个仓库里名为 xray 的 Release' });
    const sbAuto = h('input', { type: 'checkbox', checked: st.singboxAutoUpdate !== false });
    const subHttps = h('input', { type: 'checkbox', checked: st.subHttps !== false });
    const avoidWeb = h('input', { type: 'checkbox', checked: st.avoidWebPorts !== false });
    const subDomain = h('input', { value: st.subDomain || '', placeholder: '留空 = 用户主服务器的 IP；可填 sub.example.com' });
    const tz = h('select', {}, [['Asia/Shanghai', '北京时间（UTC+8）'], ['Asia/Hong_Kong', '香港'], ['Asia/Taipei', '台北'], ['Asia/Tokyo', '东京（UTC+9）'], ['Asia/Singapore', '新加坡'], ['Europe/London', '伦敦'], ['America/Los_Angeles', '洛杉矶'], ['America/New_York', '纽约'], ['UTC', 'UTC']].map(([k, l]) => h('option', { value: k }, l)));
    tz.value = st.timezone || 'Asia/Shanghai';
    const uw = st.upgradeWindow || {};
    const uwOn = h('input', { type: 'checkbox', checked: !!uw.enabled });
    const uwStart = h('input', { type: 'number', min: 0, max: 23, value: uw.start ?? 3 });
    const uwEnd = h('input', { type: 'number', min: 0, max: 23, value: uw.end ?? 5 });
    const uwRow = h('div', { class: 'row set-indent' }, field('从几点', uwStart), field('到几点', uwEnd));
    const syncUw = () => uwRow.classList.toggle('hidden', !uwOn.checked);
    uwOn.onchange = syncUw; syncUw();
    return h('div', {},
      h('div', { class: 'card' }, h('h3', {}, '端口'),
        chk(avoidWeb, '避开常用 Web 端口（TCP 80 / 443 / 8080 / 8443）', '很多服务商禁止在这几个端口上托管网站或做代理类 Web 伪装，违规会被停机。打开后自动优选、端口检测、一键换新都不会用它们，手动填写也会被拦下；已经在用的会在服务器页提示，可以一键换掉。服务商没有这条规定的话可以关')),
      h('div', { class: 'card' }, h('h3', {}, '订阅'),
        h('div', { class: 'row' }, field('订阅端口（对外开放）', subPort), field('时区', tz, '流量重置、日报、升级时间段都按这个时区算')),
        field('订阅域名（可选）', subDomain, '把一个域名解析到任意一台已部署的服务器，订阅地址就不会因为换服务器而改变'),
        chk(subHttps, '订阅链接用 HTTPS', '不需要域名：自动给每台 VPS 的 IP 申请 Let\'s Encrypt 证书，6 天有效、自动续。申请和续期时会在 TCP 80 端口临时开一个验证页（几秒钟，验证完就关），NodeDeck 会自动开防火墙；服务商有安全组的话也要放行。服务商连临时占用 80 端口都不允许的话就关掉这项。填了订阅域名时用域名')),
      h('div', { class: 'card' }, h('h3', {}, '内核与升级'),
        field('sing-box 内核渠道', sbBase, '默认是你仓库里名为 singbox 的 Release，GitHub Actions 每天自动构建官方最新正式版'),
        field('Xray 内核渠道（XHTTP 协议用）', xrBase, '只有开了 VLESS-XHTTP 的服务器才会装 Xray。默认由 GitHub Actions 每天从官方同步（校验官方 SHA2-256）'),
        chk(sbAuto, 'VPS 自动升级内核', '每 6 小时检查一次 sing-box（开了 XHTTP 的也升级 Xray），升级前校验配置，失败自动回滚'),
        chk(uwOn, '只在指定时间段升级', '避免白天升级时断线'), uwRow),
      h('div', { class: 'card' }, h('h3', {}, 'VPS 本机端口'),
        h('p', { class: 'muted', style: { marginTop: 0 } }, '只在 VPS 本机监听，不对外开放；和其它程序冲突时才需要改。'),
        h('div', { class: 'row' }, field('统计 API 端口', statsPort), field('agent 管理端口', adminPort))),
      h('div', { class: 'actions set-foot' }, h('button', { class: 'primary', onclick: async () => {
        if (avoidWeb.checked && WEB_PORTS.includes(Number(subPort.value))) { toast('订阅端口不能用 80 / 443 / 8080 / 8443（已开「避开常用 Web 端口」）', 'err'); return; }
        await api.call('settings:set', { avoidWebPorts: avoidWeb.checked, subPort: Number(subPort.value) || 2096, statsPort: Number(statsPort.value) || 9092, adminPort: Number(adminPort.value) || 9091, singboxBase: sbBase.value.trim(), xrayBase: xrBase.value.trim(), singboxAutoUpdate: sbAuto.checked,
          subDomain: subDomain.value.trim(), subHttps: subHttps.checked, timezone: tz.value, upgradeWindow: { enabled: uwOn.checked, start: Number(uwStart.value) || 0, end: Number(uwEnd.value) || 0 } });
        saved('已保存，点「同步全部」后对各 VPS 生效（改了端口需要重新部署）');
      } }, '保存')));
  };

  // ---- 连接与备份 ----
  const connPane = () => {
    const mode = st.sshProxy && st.sshProxy !== 'auto' && st.sshProxy !== 'off' ? 'custom' : (st.sshProxy || 'auto');
    const proxyMode = h('select', {}, h('option', { value: 'auto' }, '自动（直连不通时找本机 V2rayN / Clash 代理）'), h('option', { value: 'custom' }, '指定代理地址'), h('option', { value: 'off' }, '关闭（只直连）'));
    proxyMode.value = mode;
    const proxyUrl = h('input', { value: mode === 'custom' ? st.sshProxy : '', placeholder: 'socks5://127.0.0.1:10808 或 http://127.0.0.1:10809' });
    const proxyRow = field('代理地址', proxyUrl);
    const syncProxy = () => proxyRow.classList.toggle('hidden', proxyMode.value !== 'custom');
    proxyMode.onchange = syncProxy; syncProxy();
    const detected = h('span', { class: 'muted' });
    return h('div', {},
      h('div', { class: 'card' }, h('h3', {}, 'SSH 连接'),
        field('经本机代理连接 VPS', proxyMode, '国内直连 VPS 的 SSH 常被干扰；自动模式下直连失败会改走代理（密码错误不会重试）'), proxyRow,
        h('div', { class: 'actions' },
          h('button', { class: 'primary', onclick: async () => {
            const val = proxyMode.value === 'custom' ? proxyUrl.value.trim() : proxyMode.value;
            if (proxyMode.value === 'custom' && !/^(socks5?h?|http):\/\/.+:\d+$/i.test(val)) { toast('代理地址格式应为 socks5://127.0.0.1:10808', 'err'); return; }
            await api.call('settings:set', { sshProxy: val }); toast('已保存', 'ok');
          } }, '保存'),
          h('button', { onclick: (e) => busy(e.currentTarget, async () => { const l = await api.call('tools:localProxies'); detected.textContent = l.length ? '检测到：' + l.join('、') : '没有检测到本机代理'; }) }, '检测本机代理'), detected)),
      h('div', { class: 'card' }, h('h3', {}, '备份'),
        h('p', { class: 'muted', style: { marginTop: 0 } }, `备份文件包含服务器密码等敏感信息，请妥善保存。本地数据已用 Windows DPAPI 加密，存在：${info.dataDir}`),
        h('div', { class: 'actions' },
          h('button', { onclick: async () => { const p = await api.call('data:export'); if (p) toast('已导出到 ' + p, 'ok'); } }, '导出备份'),
          h('button', { onclick: async () => { if (await confirmBox('导入会覆盖当前全部数据，继续？')) { if (await api.call('data:import')) { toast('导入成功', 'ok'); render(); } } } }, '导入备份'))));
  };

  // ---- 外观与更新 ----
  const appPane = () => {
    const theme = sel([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']], st.theme || 'system');
    theme.onchange = async () => { await api.call('settings:set', { theme: theme.value }); S.settings.theme = theme.value; applyTheme(); };
    const autoUp = h('input', { type: 'checkbox', checked: st.autoUpdate !== false });
    autoUp.onchange = async () => { await api.call('settings:set', { autoUpdate: autoUp.checked }); toast('已保存', 'ok'); };
    const upd = updateCard();
    upd.insertBefore(chk(autoUp, '自动检查软件更新'), upd.querySelector('.actions'));
    const repo = info.repo && !info.repo.includes('YOUR_GITHUB_NAME') ? 'github.com/' + info.repo : '';
    return h('div', {},
      h('div', { class: 'card' }, h('h3', {}, '外观'), field('主题', theme, '深色适合长时间看监控；跟随系统会随 Windows 的深浅色自动切换')),
      upd,
      h('div', { class: 'card' }, h('h3', {}, '关于'),
        h('p', { class: 'muted', style: { marginTop: 0 } }, `NodeDeck v${info.version}${repo ? ' · ' + repo : ''} · 内置 sing-box ${info.singbox ? '✔' : '✘（节点测试不可用）'}`),
        h('p', { class: 'muted', style: { marginBottom: 0 } }, 'sing-box 以 GPL-3.0 许可证发布，作为独立程序随附。')));
  };

  const PANES = { notify: tgPane, guard: guardPane, probe: () => probeCard(), server: serverPane, conn: connPane, app: appPane };
  if (!PANES[setTab]) setTab = 'notify';
  const pane = h('div', { class: 'set-pane' });
  const tabs = h('div', { class: 'tabs set-tabs' });
  const show = () => {
    tabs.replaceChildren(...SET_TABS.map(([k, l]) => h('a', { class: setTab === k ? 'active' : '', onclick: () => { setTab = k; show(); } }, l)));
    pane.replaceChildren(PANES[setTab]());
  };
  show();
  v.append(h('h1', {}, '设置'), h('p', { class: 'sub' }, '改完点各页下面的「保存」；涉及 VPS 的设置要再点「同步全部」才生效。'), tabs, pane);
}

const VIEWS = { dash: viewDash, servers: viewServers, nodes: viewNodes, users: viewUsers, landings: viewLandings, relays: viewRelays, forwards: viewForwards, tools: viewTools, stock: viewStock, settings: viewSettings };

(async function init() {
  info = await api.call('app:info');
  updateStatus = await api.call('update:status');
  api.on('update-status', (st) => {
    const prev = updateStatus.state;
    updateStatus = st; renderFoot();
    if (prev !== st.state) renderBanner();
    else if (st.state === 'downloading') for (const el of document.querySelectorAll('.upd-progress')) el.replaceWith(updProgress(st)); // 进度原地刷新
    if (prev !== st.state && (page === 'settings' || page === 'dash')) render();
  });
  await reload();
  applyTheme();
  renderNav();
  renderBanner();
  render();
  showWhatsNew();
  api.on('toast', (p) => toast(p.text, p.level || 'warn'));
  api.on('usage-updated', () => { if (page === 'users' || page === 'dash') { if (!document.querySelector('.modal-bg')) render(); } });
})();

// 更新后第一次打开：显示这次更新了什么（读取随软件打包的 CHANGELOG.md）
function verCmp(a, b) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
async function showWhatsNew() {
  const last = S.settings.lastSeenVersion;
  if (last === info.version) return;
  await api.call('settings:set', { lastSeenVersion: info.version });
  if (!last || !info.packaged) return;
  const md = await api.call('app:changelog');
  const parts = md.split(/^## /m).slice(1).map((sec) => ({ ver: (sec.match(/^(\d+\.\d+\.\d+)/) || [])[1], text: sec })).filter((x) => x.ver && verCmp(x.ver, last) > 0 && verCmp(x.ver, info.version) <= 0);
  if (!parts.length) return;
  modal({ title: `已更新到 ${info.version}`, wide: true, body: h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, parts.map((p) => plainNotes('## ' + p.text)).join('\n\n')), buttons: [{ label: '知道了', class: 'primary' }] });
}
