'use strict';
// 真流量端到端测试：本机起一个开了全部协议的服务端（sing-box + Xray），
// 再用三种客户端内核（sing-box、Xray、mihomo）按 NodeDeck 生成的配置逐个连上去，经代理取一个本地网页。
// 用法：SINGBOX=… XRAY=… MIHOMO=… node test/e2e.js   （没给的客户端内核跳过；SINGBOX 必须给）
// 能提前发现：链接 / 订阅字段写错、客户端版本删了字段、证书指纹校验不过、内核少了编译选项等问题。
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const core = require('../src/main/core');

const SB = process.env.SINGBOX || 'sing-box';
const XR = process.env.XRAY || '';
const MH = process.env.MIHOMO || '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-e2e-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function run(bin, args, tag) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  p.tag = tag;
  procs.push(p);
  return p;
}
function stop(p) { try { p.kill('SIGKILL'); } catch (_) { /* ignore */ } }
async function waitPort(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}
// 经 HTTP 代理取本地网页
function viaProxy(proxyPort, targetPort, ms = 10000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: `http://127.0.0.1:${targetPort}/nd-e2e`, headers: { Host: `127.0.0.1:${targetPort}` }, timeout: ms }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(res.statusCode === 200 && b === 'nd-e2e-ok' ? '' : `HTTP ${res.statusCode} ${b.slice(0, 80)}`));
    });
    req.on('timeout', () => { req.destroy(); resolve('超时'); });
    req.on('error', (e) => resolve(e.message));
    req.end();
  });
}

(async () => {
  // 1. 证书：自签（和 VPS 上一样），算出客户端要用的指纹
  const sni = 'www.bing.com';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', `/CN=${sni}`, '-addext', `subjectAltName=DNS:${sni}`], { stdio: 'pipe' });
  const pem = fs.readFileSync(path.join(dir, 'cert.pem'));
  const x509 = new crypto.X509Certificate(pem);

  // 2. 本地网页（代理要取的目标）+ Reality 目标（TLS 1.3）
  const web = http.createServer((req, res) => { res.end(req.url === '/nd-e2e' ? 'nd-e2e-ok' : 'no'); });
  const webPort = await freePort();
  await new Promise((r) => web.listen(webPort, '127.0.0.1', r));
  const rt = tls.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: pem, minVersion: 'TLSv1.3', ALPNProtocols: ['h2', 'http/1.1'] }, (s) => s.end());
  const rtPort = await freePort();
  await new Promise((r) => rt.listen(rtPort, '127.0.0.1', r));

  // 3. 服务端：全部协议
  const server = core.newServer({ name: 'E2E', host: '127.0.0.1', tlsSni: sni });
  server.certSha256 = x509.fingerprint256.replace(/:/g, '').toLowerCase();
  server.certSpki = crypto.createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  server.protocols.vlessReality.sni = sni;
  for (const k of Object.keys(core.PROTOCOLS)) {
    if (core.isXray(k) && !XR) { server.protocols[k].enabled = false; continue; }
    server.protocols[k].enabled = true;
    server.protocols[k].port = await freePort();
  }
  const owner = core.newUser({ id: 'owner', name: 'owner', serverIds: '*' });
  const xp = { api: await freePort(), bridge: await freePort() };
  const state = { settings: { xrayStatsPort: xp.api, xrayBridgePort: xp.bridge }, servers: [server], users: [owner], landings: [], forwards: [] };
  const sbCfg = core.buildServerConfig(state, server);
  sbCfg.route.rules = sbCfg.route.rules.filter((r) => !r.ip_is_private); // 测试目标在 127.0.0.1
  for (const ib of sbCfg.inbounds) {
    const hs = ib.tls?.reality?.handshake;
    if (hs) { hs.server = '127.0.0.1'; hs.server_port = rtPort; }
  }
  delete sbCfg.experimental; // 不需要统计接口
  const fix = (o) => JSON.stringify(o, null, 2).replaceAll('/etc/nodedeck/cert.pem', path.join(dir, 'cert.pem')).replaceAll('/etc/nodedeck/key.pem', path.join(dir, 'key.pem'));
  fs.writeFileSync(path.join(dir, 'server.json'), fix(sbCfg));
  const sbSrv = run(SB, ['run', '-c', path.join(dir, 'server.json')], 'sing-box 服务端');
  let xrSrv = null;
  if (XR) {
    const xc = core.buildXrayConfig(state, server);
    for (const ib of xc.inbounds) if (ib.streamSettings.realitySettings) ib.streamSettings.realitySettings.target = `127.0.0.1:${rtPort}`;
    fs.writeFileSync(path.join(dir, 'xray-server.json'), fix(xc));
    xrSrv = run(XR, ['run', '-c', path.join(dir, 'xray-server.json')], 'Xray 服务端');
  }
  await sleep(2500);
  for (const p of [sbSrv, xrSrv].filter(Boolean)) {
    if (p.exitCode !== null) { console.log(`FAIL ${p.tag}启动失败：\n${p.log.slice(-1500)}`); process.exit(1); }
  }

  const entries = core.nodeEntries(state, server);
  const results = [];
  const record = (client, e, err) => {
    results.push({ client, label: e.label, err });
    console.log(`${err ? 'FAIL' : 'OK  '} ${client.padEnd(8)} ${e.label}${err ? '：' + err : ''}`);
    if (err) failed++;
  };

  // 4a. sing-box 客户端（sing-box 订阅里的出站）
  for (const e of entries) {
    const ob = core.clientOutbound(state, e, owner);
    if (!ob) continue;
    const port = await freePort();
    const f = path.join(dir, `sb-${port}.json`);
    fs.writeFileSync(f, JSON.stringify(core.clientTestConfig(ob, port)));
    const p = run(SB, ['run', '-c', f], 'sing-box 客户端');
    const up = await waitPort(port);
    let err = up ? await viaProxy(port, webPort) : '客户端没起来：' + p.log.slice(-300);
    if (err && up) { await sleep(800); err = await viaProxy(port, webPort); }
    record('sing-box', e, err ? err + (p.log ? ' | ' + p.log.trim().split('\n').slice(-2).join(' | ').slice(0, 300) : '') : '');
    stop(p);
  }

  // 4b. Xray 客户端（XHTTP 节点；v2rayN / v2rayNG 用的内核）
  if (XR) {
    for (const e of entries.filter((x) => core.isXray(x.protocol))) {
      const port = await freePort();
      const f = path.join(dir, `xr-${port}.json`);
      fs.writeFileSync(f, JSON.stringify(core.xrayTestConfig(core.xrayClientOutbound(state, e, owner), port)));
      const p = run(XR, ['run', '-c', f], 'Xray 客户端');
      const up = await waitPort(port);
      let err = up ? await viaProxy(port, webPort) : '客户端没起来：' + p.log.slice(-300);
      if (err && up) { await sleep(800); err = await viaProxy(port, webPort); }
      record('Xray', e, err);
      stop(p);
    }
  } else console.log('SKIP Xray 客户端（没设 XRAY）');

  // 4c. mihomo 客户端（Clash 订阅里的节点）
  if (MH) {
    for (const e of entries) {
      const px = core.clashProxy(state, e, owner);
      if (!px) continue;
      const port = await freePort();
      const d = path.join(dir, `mh-${port}`);
      fs.mkdirSync(d);
      const yaml = [`mixed-port: ${port}`, 'allow-lan: false', 'mode: rule', 'log-level: warning', 'ipv6: false', 'proxies:', '  - ' + JSON.stringify(px), 'rules:', `  - MATCH,${JSON.stringify(px.name)}`, ''].join('\n');
      fs.writeFileSync(path.join(d, 'config.yaml'), yaml);
      const p = run(MH, ['-d', d, '-f', path.join(d, 'config.yaml')], 'mihomo');
      const up = await waitPort(port);
      let err = up ? await viaProxy(port, webPort) : 'mihomo 没起来：' + p.log.slice(-400);
      if (err && up) { await sleep(800); err = await viaProxy(port, webPort); }
      record('mihomo', e, err ? err + (p.log ? ' | ' + p.log.trim().split('\n').slice(-2).join(' | ').slice(0, 300) : '') : '');
      stop(p);
    }
    // 完整的 Clash 订阅（DNS、TUN、规则）要能被 mihomo 读进去
    const full = core.buildSubscription(state, owner).clash;
    const d = path.join(dir, 'mh-full');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'config.yaml'), full);
    try { execFileSync(MH, ['-t', '-d', d, '-f', path.join(d, 'config.yaml')], { stdio: 'pipe', timeout: 120000 }); console.log('OK   mihomo   完整 Clash 订阅通过 mihomo -t 校验'); }
    catch (e) { failed++; console.log('FAIL mihomo   完整 Clash 订阅校验不过：' + String(e.stdout || '') + String(e.stderr || e.message).slice(-600)); }
  } else console.log('SKIP mihomo 客户端（没设 MIHOMO）');

  for (const p of procs) stop(p);
  web.close(); rt.close();
  console.log(`\n${results.length - failed} / ${results.length} 个连接通过${failed ? `，${failed} 个失败` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); for (const p of procs) stop(p); process.exit(1); });
