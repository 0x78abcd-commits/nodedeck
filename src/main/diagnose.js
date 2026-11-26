'use strict';
// 一键体检 + 被墙检测
// 顺序：本机→SSH 端口 → SSH 登录 → 服务状态 → 服务器出网/出口 IP → 时间 → 端口监听 → 本机→协议端口 → 海外→端口(check-host.net) → 节点真连
const core = require('./core');
const tools = require('./tools');

const NODE_RE = /^([a-z]+)\d*\.node\.check-host\.net$/;

// 用 check-host.net 从海外多个节点测 TCP 端口（会把 IP 和端口发给该网站）
async function checkHostTcp(fetchFn, host, port, maxNodes = 6) {
  const target = host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
  const r = await fetchFn(`https://check-host.net/check-tcp?host=${encodeURIComponent(target)}&max_nodes=${maxNodes}`, { headers: { Accept: 'application/json' } });
  const j = await r.json();
  if (!j.ok || !j.request_id) throw new Error('check-host.net 没有返回结果');
  const meta = j.nodes || {};
  let res = {};
  for (let i = 0; i < 12; i++) {
    await new Promise((x) => setTimeout(x, 2000));
    const rr = await fetchFn(`https://check-host.net/check-result/${j.request_id}`, { headers: { Accept: 'application/json' } });
    res = await rr.json();
    if (Object.values(res).every((v) => v !== null)) break;
  }
  const nodes = Object.keys(meta).map((n) => {
    const v = res[n];
    const [cc, country, city] = meta[n] || [];
    const first = Array.isArray(v) ? v[0] : null;
    return {
      node: (n.match(NODE_RE) || [])[1] || n, cc, country, city,
      ok: !!(first && first.time !== undefined && !first.error),
      ms: first && first.time !== undefined ? Math.round(first.time * 1000) : null,
      error: first?.error || (v === null || v === undefined ? '无结果' : ''),
    };
  });
  return { nodes, okCount: nodes.filter((n) => n.ok).length, total: nodes.length, link: j.permanent_link || `https://check-host.net/check-result/${j.request_id}` };
}

function verdictFor(local, overseas) {
  if (local.ok) return { level: 'ok', text: '本机能连通' };
  if (!overseas) return { level: 'fail', text: '本机连不通' };
  const ratio = overseas.total ? overseas.okCount / overseas.total : 0;
  if (ratio >= 0.5) return { level: 'fail', blocked: true, text: `海外 ${overseas.okCount}/${overseas.total} 个节点能通、本机不通：很可能被墙了` };
  if (overseas.okCount === 0) return { level: 'fail', closed: true, text: '海外和本机都连不通：端口没开、防火墙/安全组没放行，或服务器关机' };
  return { level: 'warn', text: `海外只有 ${overseas.okCount}/${overseas.total} 个节点能通，本机不通：线路不稳或部分地区被封` };
}

// 工具箱用：检测任意 IP:端口 是否被墙
async function blockCheck(fetchFn, host, port) {
  const h = String(host).trim();
  const local = await tools.tcpPing(h, Number(port), 5000);
  let overseas = null;
  let overseasError = '';
  try { overseas = await checkHostTcp(fetchFn, h, Number(port)); } catch (e) { overseasError = e.message; }
  return { host: h, port: Number(port), local, overseas, overseasError, verdict: verdictFor(local, overseas), pingpe: `https://ping.pe/${h}:${port}` };
}

// deps: { deploy, testEntry(entry) => nodetest result, fetchFn, log(step) }
async function diagnoseServer(state, server, deps) {
  const steps = [];
  const add = (step) => { steps.push(step); deps.log && deps.log(step); return step; };
  const port = Number(server.sshPort) || 22;
  const advice = new Set();

  // 1. 本机 → SSH 端口
  const sshTcp = await tools.tcpPing(server.host, port, 6000);
  add({ id: 'ssh-port', title: `本机连 SSH 端口 ${port}`, level: sshTcp.ok ? 'ok' : 'warn', text: sshTcp.ok ? `${sshTcp.ms} ms` : `不通（${sshTcp.error}），下一步会尝试经本机代理` });

  // 2. SSH 登录 + 服务器自检
  let self = null;
  try {
    self = await deps.deploy.serverSelfCheck(server);
    add({ id: 'ssh', title: 'SSH 登录', level: 'ok', text: self.via ? `成功（经本机代理 ${self.via}）` : '成功' });
  } catch (e) {
    add({ id: 'ssh', title: 'SSH 登录', level: 'fail', text: e.message });
  }

  if (self) {
    const st = self.status;
    const svcOk = st.singbox && st.agent;
    add({ id: 'services', title: '服务状态', level: svcOk ? 'ok' : 'fail', text: `sing-box ${st.singbox ? '运行中' : '没在运行'}，agent ${st.agent ? '运行中' : '没在运行'}${st.version ? `（内核 ${st.version}）` : ''}` });
    if (core.usesXray(server)) add({ id: 'xray', title: 'Xray（XHTTP 协议）', level: st.xray ? 'ok' : 'fail', text: st.xray ? `运行中${st.xrayVersion ? `（${st.xrayVersion}）` : ''}` : '没在运行：点「同步」重试，或「查看日志」看 nodedeck-xray 的报错；其它协议不受影响' });
    if (!svcOk) advice.add(server.deployedAt ? '服务没在运行：点「日志」看原因，或点「重新部署」' : '这台服务器还没部署，先点「部署」');

    add({ id: 'outbound', title: '服务器出网', level: self.netOk ? 'ok' : 'fail', text: self.netOk ? `能访问外网（${self.netMs} ms）` : '服务器自己访问不了外网：检查 VPS 的网络 / DNS' });
    if (!self.netOk) advice.add('服务器本身不能上网，节点肯定用不了，先联系服务商或检查 DNS');

    if (self.clockSkew !== null) {
      const sk = Math.abs(self.clockSkew);
      add({ id: 'clock', title: '服务器时间', level: sk > 90 ? 'fail' : sk > 30 ? 'warn' : 'ok', text: sk <= 30 ? '准确' : `和本机相差 ${sk} 秒` });
      if (sk > 90) advice.add('服务器时间偏差太大，VMess 等协议会认证失败：在 VPS 上开启时间同步（timedatectl set-ntp true）');
    }

    const missing = [];
    for (const [k, meta] of Object.entries(core.PROTOCOLS)) {
      const pc = server.protocols?.[k];
      if (!pc?.enabled) continue;
      if (self.listening.length && !core.netsOf(meta.net).every((n) => self.listening.includes(`${n}/${pc.port}`))) missing.push(`${meta.label}:${pc.port}`);
    }
    if (svcOk) add({ id: 'listen', title: '端口监听', level: missing.length ? 'fail' : 'ok', text: missing.length ? `这些端口没在监听：${missing.join('、')}` : '所有协议端口都在监听' });
    if (missing.length) advice.add('有端口没在监听：点「同步」重新下发配置，仍不行就看「日志」');
  }

  // 3. 本机 → TCP 协议端口
  const tcpPorts = [];
  for (const [k, meta] of Object.entries(core.PROTOCOLS)) {
    const pc = server.protocols?.[k];
    if (pc?.enabled && core.netsOf(meta.net).includes('tcp')) tcpPorts.push({ key: k, label: meta.label, port: Number(pc.port) });
  }
  const local = await Promise.all(tcpPorts.map(async (p) => ({ ...p, r: await tools.tcpPing(server.host, p.port, 5000) })));
  const localFail = local.filter((x) => !x.r.ok);
  if (local.length) add({ id: 'ports-local', title: '本机连协议端口（TCP）', level: localFail.length ? (localFail.length === local.length ? 'fail' : 'warn') : 'ok', text: local.map((x) => `${x.label}:${x.port} ${x.r.ok ? x.r.ms + 'ms' : '不通'}`).join('，') });

  // 4. 本机不通的，从海外复核
  let blocked = false;
  const toCheck = [];
  if (!sshTcp.ok) toCheck.push({ label: 'SSH', port });
  for (const x of localFail.slice(0, 3)) toCheck.push({ label: x.label, port: x.port });
  for (const t of toCheck) {
    try {
      const o = await checkHostTcp(deps.fetchFn, server.host, t.port);
      const v = verdictFor({ ok: false }, o);
      if (v.blocked) blocked = true;
      if (v.closed) advice.add(`${t.label} 端口 ${t.port} 海外也不通：去云厂商控制台的安全组/防火墙放行这个端口（TCP${t.label === 'SSH' ? '' : ' 和 UDP'}）`);
      add({ id: 'overseas-' + t.port, title: `海外连 ${t.label} 端口 ${t.port}`, level: v.level, text: v.text, link: o.link });
    } catch (e) {
      add({ id: 'overseas-' + t.port, title: `海外连 ${t.label} 端口 ${t.port}`, level: 'skip', text: '海外检测失败：' + e.message });
    }
  }
  if (blocked) {
    advice.add('判断为被墙：先试试「一键换新」（换端口和密钥）；如果 SSH 端口也被墙，多半是整个 IP 被封，可以加中转、换 IP，或以后用 Cloudflare 隧道');
    advice.add(`想再确认可以打开 https://ping.pe/${server.host}:${toCheck[0]?.port || port} 多地测试`);
  }

  // 5. 节点真连（含 UDP 协议）
  if (deps.testEntry && server.deployedAt) {
    const entries = core.nodeEntries(state, server).filter((e) => !e.via);
    const results = [];
    for (const e of entries) {
      const r = await deps.testEntry(e);
      results.push({ e, r });
      add({ id: 'real-' + e.protocol, title: `真连 ${core.PROTOCOLS[e.protocol].label}`, level: r.ok ? 'ok' : 'fail', text: r.ok ? `${r.latency} ms，出口 ${r.ip?.query || '?'} ${r.ip?.country || ''}${r.ip?.hosting ? '（机房 IP）' : ''}` : (r.error || '失败').split('\n')[0] });
    }
    const okOnes = results.filter((x) => x.r.ok);
    const badOnes = results.filter((x) => !x.r.ok);
    const portsAllOk = local.length && !localFail.length;
    if (results.length && !okOnes.length && portsAllOk) advice.add('端口都能连上，但所有协议真连都失败：可能是本机网络问题（先关掉其他代理 / TUN 软件再试），或协议特征被识别封锁（可以「一键换新」或加中转）；也可以点「日志」看服务器端有没有报错');
    if (badOnes.length && okOnes.length) advice.add(`部分协议能用（${okOnes.map((x) => core.PROTOCOLS[x.e.protocol].label).join('、')}），用不了的可能是端口被封或被运营商 QoS，可以「一键换新」或先用能用的`);
    if (badOnes.some((x) => x.e.protocol === 'hysteria2' || x.e.protocol === 'tuic') && okOnes.some((x) => core.netsOf(core.PROTOCOLS[x.e.protocol].net).includes('tcp'))) advice.add('UDP 协议（Hy2 / TUIC）不通而 TCP 协议正常：本地网络或运营商可能限制了 UDP，换用 TCP 协议即可');
  }

  if (!advice.size && steps.some((st) => st.level === 'fail')) advice.add('按上面标红的步骤排查；看不懂可以把这页截图发给我');
  const worst = steps.some((s) => s.level === 'fail') ? 'fail' : steps.some((s) => s.level === 'warn') ? 'warn' : 'ok';
  if (worst === 'ok') advice.add('一切正常');
  return { steps, level: worst, blocked, advice: [...advice] };
}

module.exports = { checkHostTcp, blockCheck, diagnoseServer, verdictFor };
