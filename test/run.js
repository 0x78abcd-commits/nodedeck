'use strict';
// 用真实 sing-box 校验生成的配置：SINGBOX=/path/to/sing-box node test/run.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../src/main/core');
const SB = process.env.SINGBOX || 'sing-box';

function check(name, cfg) {
  const f = path.join(os.tmpdir(), `nd-test-${name}.json`);
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
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
const sub = core.buildSubscription(state, owner);
console.log(sub.links.join('\n'));
console.log(sub.clash.split('\n').slice(0, 8).join('\n'));
console.log('agent users', JSON.stringify(core.buildAgentUsers(state, node)));
