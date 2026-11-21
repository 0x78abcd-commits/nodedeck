'use strict';
// 用真实 sing-box 校验生成的配置：SINGBOX=/path/to/sing-box node test/run.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../src/main/core');
const SB = process.env.SINGBOX || 'sing-box';

// 其他模块用到的 core.xxx 必须都已导出（防止漏导出导致运行时报错）
{
  const used = new Set();
  for (const f of ['main', 'deploy', 'diagnose', 'store', 'nodetest']) {
    for (const m of fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f + '.js'), 'utf8').matchAll(/\bcore\.([a-zA-Z_][a-zA-Z0-9_]*)\s*[(.[,)]/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in core));
  if (missing.length) { console.log('FAIL core 未导出：' + missing.join(', ')); process.exitCode = 1; } else console.log('OK   core-exports');
}

// 自签证书放临时目录，测试不依赖 /etc/nodedeck
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=test'], { stdio: 'pipe' });

function check(name, cfg) {
  const f = path.join(os.tmpdir(), `nd-test-${name.replace(/[^\w.-]/g, '_')}.json`);
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2).replaceAll('/etc/nodedeck/cert.pem', path.join(certDir, 'cert.pem')).replaceAll('/etc/nodedeck/key.pem', path.join(certDir, 'key.pem')));
  try { execFileSync(SB, ['check', '-c', f], { stdio: 'pipe' }); console.log('OK  ', name); }
  catch (e) { console.log('FAIL', name, String(e.stderr || e.message)); process.exitCode = 1; }
}

const node = core.newServer({ name: 'HK1', host: '1.2.3.4' });
const node2 = core.newServer({ name: 'US1', host: '2001:db8::1', exit: { type: 'landing', landingId: 'l1' } });
const relay = core.newServer({ name: 'Relay', host: '5.6.7.8', role: 'relay' });
for (const k of Object.keys(relay.protocols)) relay.protocols[k].enabled = false;
const state = {
  settings: { subPort: 2096, clashPort: 9090 },
  servers: [node, node2, relay],
  landings: [{ id: 'l1', name: '住宅', type: 'socks', host: '9.9.9.9', port: 1080, username: 'a', password: 'b' }],
  forwards: [
    { id: 'f1', relayServerId: relay.id, listenPort: 30001, target: { type: 'node', serverId: node.id, protocol: 'vlessReality' } },
    { id: 'f2', relayServerId: relay.id, listenPort: 30002, target: { type: 'node', serverId: node.id, protocol: 'hysteria2' } },
    { id: 'f3', relayServerId: relay.id, listenPort: 30003, target: { type: 'custom', host: 'example.com', port: 80 } },
  ],
  users: [core.newUser({ id: 'owner', name: 'owner', serverIds: '*' }), core.newUser({ name: 'alice', serverIds: [node.id], limitGB: 10 })],
};
check('node', core.buildServerConfig(state, node));
check('node-landing', core.buildServerConfig(state, node2));
check('relay', core.buildServerConfig(state, relay));
for (const s of state.servers) { const c = core.checkPortConflicts(state, s); if (c.length) console.log('conflict', s.name, c); }

const owner = state.users[0];
for (const e of core.userEntries(state, owner)) {
  check('client-' + e.label, core.clientTestConfig(core.clientOutbound(state, e, owner), 18080));
}
check('singbox-client-sub', core.buildSingboxClient(state, owner));
// 重名服务器也要能通过（名称去重）
const dup = core.newServer({ name: 'HK1', host: '9.8.7.6' });
const st2 = { ...state, servers: [...state.servers, dup] };
check('singbox-client-dup-names', core.buildSingboxClient(st2, owner));
// ---------- 0.4.0：SS2022、Hy2 混淆+端口跳跃、ACME、IPv6、路由规则、WARP、机场节点落地 ----------
const crypto = require('crypto');
const links = require('../src/main/links');
const full = core.newServer({ name: 'JP1', host: '3.3.3.3', host6: '2001:db8::3', ipMode: 'dual', domain: 'jp1.example.com', acme: true, acmeEmail: 'a@example.com' });
full.protocols.shadowsocks.enabled = true;
full.protocols.hysteria2.obfs = 'obfspass';
full.protocols.hysteria2.hopPorts = '20000-30000';
full.routing = { blockBT: true, blockAds: true, blockCN: true, warp: { enabled: true, sites: ['openai', 'netflix', 'google'] } };
const k = () => crypto.randomBytes(32).toString('base64');
full.warp = { privateKey: k(), peerPublicKey: k(), address4: '172.16.0.2', address6: '2606:4700:110:8a36::1', reserved: [1, 2, 3], endpointHost: '162.159.192.1', endpointPort: 2408 };
const st3 = { ...state, servers: [...state.servers, full] };
st3.users = state.users.map((u) => ({ ...u }));
check('server-full-0.4', core.buildServerConfig(st3, full));
const conflicts = core.checkPortConflicts(st3, full);
if (conflicts.length) { console.log('FAIL conflicts', conflicts); process.exitCode = 1; } else console.log('OK   no-conflicts-0.4');
for (const e of core.nodeEntries(st3, full)) check('client-0.4-' + e.label, core.clientTestConfig(core.clientOutbound(st3, e, owner), 18081));
check('singbox-client-0.4', core.buildSingboxClient(st3, owner));
console.log(core.nodeEntries(st3, full).map((e) => core.shareLink(st3, e, owner)).filter((l) => /^(ss|hysteria2|trojan):/.test(l)).join('\n'));
// 落地：各种分享链接
const sampleLinks = [
  'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw&sid=6ba85179e30d4fc2&type=tcp#机场-美国',
  'vless://11111111-2222-3333-4444-555555555555@cdn.example.com:443?encryption=none&security=tls&sni=a.example.com&type=ws&host=a.example.com&path=%2Fws#ws-tls',
  'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'vm-ws-tls', add: '5.6.7.8', port: '443', id: '11111111-2222-3333-4444-555555555555', aid: '0', scy: 'auto', net: 'ws', host: 'b.example.com', path: '/v', tls: 'tls', sni: 'b.example.com' })).toString('base64'),
  'trojan://pass%40word@9.9.9.9:443?security=tls&sni=t.example.com&type=grpc&serviceName=gs#tj-grpc',
  'ss://' + Buffer.from('2022-blake3-aes-128-gcm:' + crypto.randomBytes(16).toString('base64') + ':' + crypto.randomBytes(16).toString('base64')).toString('base64') + '@8.8.4.4:8388#ss2022',
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.1.1.1:8388#ss-aes',
  'hysteria2://pw@2.2.2.2:443?sni=h.example.com&insecure=1&obfs=salamander&obfs-password=xx&mport=20000-30000#hy2',
  'tuic://11111111-2222-3333-4444-555555555555:pw@3.3.3.3:443?congestion_control=bbr&alpn=h3&sni=t.example.com#tuic',
  'anytls://pw@4.4.4.4:443?sni=a.example.com&insecure=1#anytls',
  'socks://dXNlcjpwYXNz@5.5.5.5:1080#socks-b64',
];
for (const l of sampleLinks) {
  try { const r = links.parseShareLink(l, 'exit'); check('landing-' + r.name, core.clientTestConfig({ ...r.outbound, tag: 'proxy' }, 18082)); }
  catch (e) { console.log('FAIL landing-parse', l.slice(0, 40), e.message); process.exitCode = 1; }
}
const withLink = { ...state, landings: [{ id: 'l2', type: 'link', link: sampleLinks[0], name: '机场' }] };
const exitSrv = core.newServer({ name: 'EXIT', host: '7.7.7.7', exit: { type: 'landing', landingId: 'l2' } });
check('server-with-link-landing', core.buildServerConfig({ ...withLink, servers: [exitSrv] }, exitSrv));
const sub = core.buildSubscription(state, owner);
console.log(sub.links.join('\n'));
console.log(sub.clash.split('\n').slice(0, 8).join('\n'));
console.log('agent users', JSON.stringify(core.buildAgentUsers(state, node)));
