'use strict';
// 纯逻辑模块：不依赖 Electron，便于测试。
// 负责：sing-box 服务端配置生成、分享链接、订阅（v2rayN base64 / Clash Meta）、本地测试用客户端出站。

const crypto = require('crypto');

const REMOTE_DIR = '/etc/nodedeck';
const CERT_PATH = `${REMOTE_DIR}/cert.pem`;
const KEY_PATH = `${REMOTE_DIR}/key.pem`;

const PROTOCOLS = {
  vlessReality: { label: 'VLESS-Reality', net: 'tcp', defaultPort: 443 },
  trojan: { label: 'Trojan', net: 'tcp', defaultPort: 2083 },
  vmess: { label: 'VMess-WS', net: 'tcp', defaultPort: 2082 },
  hysteria2: { label: 'Hysteria2', net: 'udp', defaultPort: 443 },
  tuic: { label: 'TUIC', net: 'udp', defaultPort: 8443 },
  anytls: { label: 'AnyTLS', net: 'tcp', defaultPort: 8443 },
};

// ---------- 工具函数 ----------
function randId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}
function randHex(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); }
function randPassword(len = 16) { return crypto.randomBytes(len).toString('base64url').slice(0, len); }
function uuid() { return crypto.randomUUID(); }

// Reality 用 X25519 密钥对，sing-box 使用 base64 RawURL 编码
function realityKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const priv = privateKey.export({ format: 'jwk' }).d;
  return { privateKey: priv, publicKey: pub };
}

function defaultProtocols() {
  const kp = realityKeypair();
  return {
    vlessReality: { enabled: true, port: 443, sni: 'www.microsoft.com', privateKey: kp.privateKey, publicKey: kp.publicKey, shortId: randHex(4) },
    trojan: { enabled: true, port: 2083 },
    vmess: { enabled: true, port: 2082, path: '/' + randId(6) },
    hysteria2: { enabled: true, port: 443, upMbps: 0, downMbps: 0 },
    tuic: { enabled: true, port: 8443 },
    anytls: { enabled: true, port: 8443 },
  };
}

function newServer(fields = {}) {
  return {
    id: 's' + randId(7),
    name: fields.name || fields.host || '新服务器',
    host: '',
    sshPort: 22,
    username: 'root',
    authType: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    role: 'node',
    tlsSni: 'www.bing.com',
    exit: { type: 'direct' },
    protocols: defaultProtocols(),
    deployedAt: null,
    ...fields,
  };
}

function newUser(fields = {}) {
  return {
    id: 'u' + randId(7),
    name: '新用户',
    uuid: uuid(),
    password: randPassword(16),
    token: randPassword(24),
    serverIds: [],
    limitGB: 0,
    expireAt: null,
    enabled: true,
    note: '',
    usage: {},
    createdAt: Date.now(),
    ...fields,
  };
}

const GB = 1024 ** 3;

function userUsedBytes(user) {
  let total = 0;
  for (const v of Object.values(user.usage || {})) total += (v.up || 0) + (v.down || 0);
  return total;
}

// 用户当前是否可用（启用、未到期、未超额）
// 实际到期时间：「首次使用后 N 天」的用户在第一次使用前不计时
function userExpireAt(user) {
  if (user.expireAfterDays > 0) return user.firstUsedAt ? user.firstUsedAt + user.expireAfterDays * 86400000 : null;
  return user.expireAt || null;
}

function userStatus(user, now = Date.now()) {
  if (!user.enabled) return { active: false, reason: '已停用' };
  const exp = userExpireAt(user);
  if (exp && now >= exp) return { active: false, reason: '已到期' };
  if (user.limitGB > 0 && userUsedBytes(user) >= user.limitGB * GB) return { active: false, reason: '流量用尽' };
  return { active: true, reason: '正常' };
}

function userHasServer(user, serverId) {
  return user.serverIds === '*' || (Array.isArray(user.serverIds) && user.serverIds.includes(serverId));
}

function usersForServer(state, server) {
  return (state.users || []).filter((u) => userHasServer(u, server.id));
}

function landingOutbound(landing, tag) {
  const o = {
    type: landing.type === 'http' ? 'http' : 'socks',
    tag,
    server: landing.host,
    server_port: Number(landing.port),
  };
  if (o.type === 'socks') o.version = '5';
  if (landing.username) { o.username = landing.username; o.password = landing.password || ''; }
  return o;
}

function tlsSelfSigned(server, alpn) {
  const t = { enabled: true, server_name: server.tlsSni || 'www.bing.com', certificate_path: CERT_PATH, key_path: KEY_PATH };
  if (alpn) t.alpn = alpn;
  return t;
}

// ---------- 服务端配置 ----------
// opts.includeInactive: agent 需要完整配置（含已停用用户），由 agent 自己过滤；默认 true
function buildServerConfig(state, server, opts = {}) {
  const settings = state.settings || {};
  const includeInactive = opts.includeInactive !== false;
  const users = usersForServer(state, server).filter((u) => includeInactive || userStatus(u).active);
  const p = server.protocols || {};
  const inbounds = [];
  const listen = '::';

  if (p.vlessReality?.enabled) {
    inbounds.push({
      type: 'vless', tag: 'vless-in', listen, listen_port: Number(p.vlessReality.port),
      users: users.map((u) => ({ name: u.id, uuid: u.uuid, flow: 'xtls-rprx-vision' })),
      tls: {
        enabled: true,
        server_name: p.vlessReality.sni,
        reality: {
          enabled: true,
          handshake: { server: p.vlessReality.sni, server_port: 443 },
          private_key: p.vlessReality.privateKey,
          short_id: [p.vlessReality.shortId],
        },
      },
    });
  }
  if (p.trojan?.enabled) {
    inbounds.push({
      type: 'trojan', tag: 'trojan-in', listen, listen_port: Number(p.trojan.port),
      users: users.map((u) => ({ name: u.id, password: u.password })),
      tls: tlsSelfSigned(server),
    });
  }
  if (p.vmess?.enabled) {
    inbounds.push({
      type: 'vmess', tag: 'vmess-in', listen, listen_port: Number(p.vmess.port),
      users: users.map((u) => ({ name: u.id, uuid: u.uuid, alterId: 0 })),
      transport: { type: 'ws', path: p.vmess.path || '/' },
    });
  }
  if (p.hysteria2?.enabled) {
    const ib = {
      type: 'hysteria2', tag: 'hy2-in', listen, listen_port: Number(p.hysteria2.port),
      users: users.map((u) => ({ name: u.id, password: u.password })),
      tls: tlsSelfSigned(server, ['h3']),
    };
    if (Number(p.hysteria2.upMbps) > 0) ib.up_mbps = Number(p.hysteria2.upMbps);
    if (Number(p.hysteria2.downMbps) > 0) ib.down_mbps = Number(p.hysteria2.downMbps);
    inbounds.push(ib);
  }
  if (p.tuic?.enabled) {
    inbounds.push({
      type: 'tuic', tag: 'tuic-in', listen, listen_port: Number(p.tuic.port),
      users: users.map((u) => ({ name: u.id, uuid: u.uuid, password: u.password })),
      congestion_control: 'bbr',
      tls: tlsSelfSigned(server, ['h3']),
    });
  }
  if (p.anytls?.enabled) {
    inbounds.push({
      type: 'anytls', tag: 'anytls-in', listen, listen_port: Number(p.anytls.port),
      users: users.map((u) => ({ name: u.id, password: u.password })),
      tls: tlsSelfSigned(server),
    });
  }

  // 本机作为中转：端口转发
  const forwards = (state.forwards || []).filter((f) => f.relayServerId === server.id && f.enabled !== false);
  const fwdTags = [];
  for (const f of forwards) {
    const target = resolveForwardTarget(state, f);
    if (!target) continue;
    const ib = {
      type: 'direct', tag: 'fwd-' + f.id, listen, listen_port: Number(f.listenPort),
      override_address: target.host, override_port: Number(target.port),
    };
    if (target.network === 'tcp' || target.network === 'udp') ib.network = target.network;
    inbounds.push(ib);
    fwdTags.push(ib.tag);
  }

  // 出站：直连或经住宅落地；流量统计由 V2Ray API 按用户计数（需要 with_v2ray_api 构建）
  const outbounds = [{ type: 'direct', tag: 'direct' }];
  let landing = null;
  if (server.exit?.type === 'landing') landing = (state.landings || []).find((l) => l.id === server.exit.landingId) || null;
  if (landing) outbounds.push(landingOutbound(landing, 'exit'));
  const finalTag = landing ? 'exit' : 'direct';

  const rules = [{ action: 'sniff' }];
  if (fwdTags.length) rules.push({ inbound: fwdTags, outbound: 'direct' });
  rules.push({ ip_is_private: true, action: 'reject' });

  return {
    log: { level: 'warn', timestamp: true },
    dns: { servers: [{ type: 'local', tag: 'local' }] },
    inbounds,
    outbounds,
    route: { rules, final: finalTag, default_domain_resolver: 'local' },
    experimental: {
      v2ray_api: {
        listen: `127.0.0.1:${settings.statsPort || 9092}`,
        stats: { enabled: true, users: users.map((u) => u.id) },
      },
    },
  };
}

function resolveForwardTarget(state, f) {
  const t = f.target || {};
  if (t.type === 'node') {
    const s = (state.servers || []).find((x) => x.id === t.serverId);
    const pc = s?.protocols?.[t.protocol];
    if (!s || !pc) return null;
    return { host: s.host, port: pc.port, network: PROTOCOLS[t.protocol]?.net || '' };
  }
  if (!t.host || !t.port) return null;
  return { host: t.host, port: t.port, network: t.network || '' };
}

// ---------- 节点入口（直连 + 经中转） ----------
function nodeEntries(state, server) {
  const out = [];
  const p = server.protocols || {};
  for (const key of Object.keys(PROTOCOLS)) {
    if (!p[key]?.enabled) continue;
    out.push({ serverId: server.id, protocol: key, host: server.host, port: Number(p[key].port), label: `${server.name}-${PROTOCOLS[key].label}` });
  }
  for (const f of state.forwards || []) {
    if (f.enabled === false || f.target?.type !== 'node' || f.target.serverId !== server.id) continue;
    if (!p[f.target.protocol]?.enabled) continue;
    const relay = (state.servers || []).find((x) => x.id === f.relayServerId);
    if (!relay) continue;
    out.push({
      serverId: server.id, protocol: f.target.protocol, host: relay.host, port: Number(f.listenPort),
      label: `${server.name}-${PROTOCOLS[f.target.protocol].label}-经${relay.name}`, via: relay.id,
    });
  }
  return out;
}

function hostForUri(h) { return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h; }

function shareLink(state, entry, user) {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const host = hostForUri(entry.host);
  const port = entry.port;
  const name = encodeURIComponent(entry.label);
  const sni = encodeURIComponent(server.tlsSni || 'www.bing.com');
  switch (entry.protocol) {
    case 'vlessReality':
      return `vless://${user.uuid}@${host}:${port}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${encodeURIComponent(pc.sni)}&fp=chrome&pbk=${pc.publicKey}&sid=${pc.shortId}&type=tcp#${name}`;
    case 'trojan':
      return `trojan://${encodeURIComponent(user.password)}@${host}:${port}?security=tls&sni=${sni}&allowInsecure=1&type=tcp#${name}`;
    case 'vmess': {
      const j = { v: '2', ps: entry.label, add: entry.host, port: String(port), id: user.uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: '', path: pc.path || '/', tls: '' };
      return 'vmess://' + Buffer.from(JSON.stringify(j)).toString('base64');
    }
    case 'hysteria2':
      return `hysteria2://${encodeURIComponent(user.password)}@${host}:${port}?sni=${sni}&insecure=1#${name}`;
    case 'tuic':
      return `tuic://${user.uuid}:${encodeURIComponent(user.password)}@${host}:${port}?congestion_control=bbr&alpn=h3&sni=${sni}&allow_insecure=1&udp_relay_mode=native#${name}`;
    case 'anytls':
      return `anytls://${encodeURIComponent(user.password)}@${host}:${port}?sni=${sni}&insecure=1#${name}`;
    default:
      return '';
  }
}

function clashProxy(state, entry, user) {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const base = { name: entry.label, server: entry.host, port: entry.port };
  const sni = server.tlsSni || 'www.bing.com';
  switch (entry.protocol) {
    case 'vlessReality':
      return { ...base, type: 'vless', uuid: user.uuid, network: 'tcp', tls: true, udp: true, flow: 'xtls-rprx-vision', servername: pc.sni, 'client-fingerprint': 'chrome', 'reality-opts': { 'public-key': pc.publicKey, 'short-id': pc.shortId } };
    case 'trojan':
      return { ...base, type: 'trojan', password: user.password, sni, 'skip-cert-verify': true, udp: true };
    case 'vmess':
      return { ...base, type: 'vmess', uuid: user.uuid, alterId: 0, cipher: 'auto', network: 'ws', 'ws-opts': { path: pc.path || '/' }, udp: true };
    case 'hysteria2':
      return { ...base, type: 'hysteria2', password: user.password, sni, 'skip-cert-verify': true };
    case 'tuic':
      return { ...base, type: 'tuic', uuid: user.uuid, password: user.password, sni, alpn: ['h3'], 'skip-cert-verify': true, 'congestion-controller': 'bbr', 'udp-relay-mode': 'native' };
    case 'anytls':
      return { ...base, type: 'anytls', password: user.password, sni, 'skip-cert-verify': true, udp: true, 'client-fingerprint': 'chrome' };
    default:
      return null;
  }
}

// sing-box 客户端出站（用于本地节点测试）
function clientOutbound(state, entry, user, tag = 'proxy') {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const base = { tag, server: entry.host, server_port: entry.port };
  const sni = server.tlsSni || 'www.bing.com';
  const insecureTls = (alpn) => ({ enabled: true, server_name: sni, insecure: true, ...(alpn ? { alpn } : {}) });
  switch (entry.protocol) {
    case 'vlessReality':
      return { ...base, type: 'vless', uuid: user.uuid, flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: pc.sni, utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: pc.publicKey, short_id: pc.shortId } } };
    case 'trojan':
      return { ...base, type: 'trojan', password: user.password, tls: insecureTls() };
    case 'vmess':
      return { ...base, type: 'vmess', uuid: user.uuid, security: 'auto', alter_id: 0, transport: { type: 'ws', path: pc.path || '/' } };
    case 'hysteria2':
      return { ...base, type: 'hysteria2', password: user.password, tls: insecureTls(['h3']) };
    case 'tuic':
      return { ...base, type: 'tuic', uuid: user.uuid, password: user.password, congestion_control: 'bbr', tls: insecureTls(['h3']) };
    case 'anytls':
      return { ...base, type: 'anytls', password: user.password, tls: insecureTls() };
    default:
      return null;
  }
}

function clientTestConfig(outbound, mixedPort) {
  return {
    log: { level: 'error' },
    dns: { servers: [{ type: 'local', tag: 'local' }] },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: mixedPort }],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: { final: outbound.tag, default_domain_resolver: 'local' },
  };
}

// ---------- 订阅 ----------
function userEntries(state, user) {
  const out = [];
  for (const s of state.servers || []) {
    if (!userHasServer(user, s.id)) continue;
    for (const e of nodeEntries(state, s)) out.push(e);
  }
  return out;
}

function toYamlValue(v) { return JSON.stringify(v); }

function clashYaml(proxies) {
  const names = proxies.map((p) => p.name);
  const lines = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'proxies:',
    ...proxies.map((p) => '  - ' + toYamlValue(p)),
    'proxy-groups:',
    '  - ' + toYamlValue({ name: '节点选择', type: 'select', proxies: ['自动选择', ...names] }),
    '  - ' + toYamlValue({ name: '自动选择', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 300, proxies: names.length ? names : ['DIRECT'] }),
    'rules:',
    '  - GEOIP,CN,DIRECT',
    '  - MATCH,节点选择',
    '',
  ];
  return lines.join('\n');
}

// 节点名去重（不同服务器起了同名时加序号），Clash / sing-box 要求名称唯一
function uniqueEntries(entries) {
  const seen = new Map();
  return entries.map((e) => {
    const n = (seen.get(e.label) || 0) + 1;
    seen.set(e.label, n);
    return n === 1 ? e : { ...e, label: `${e.label}-${n}` };
  });
}

// sing-box 客户端配置（SFA / SFI / SFM 等，需 sing-box 1.12 及以上）
function buildSingboxClient(state, user) {
  const entries = uniqueEntries(userEntries(state, user));
  const outs = entries.map((e) => clientOutbound(state, e, user, e.label)).filter(Boolean);
  const names = outs.map((o) => o.tag);
  const ruleSet = (tag, repo) => ({ type: 'remote', tag, format: 'binary', url: `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${tag}.srs`, download_detour: '节点选择' });
  return {
    log: { level: 'warn', timestamp: true },
    dns: {
      servers: [
        { type: 'https', tag: 'remote', server: '1.1.1.1', detour: '节点选择' },
        { type: 'udp', tag: 'local', server: '223.5.5.5' },
      ],
      rules: [{ rule_set: 'geosite-cn', server: 'local' }],
      final: 'remote',
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], auto_route: true, strict_route: true },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds: [
      { type: 'selector', tag: '节点选择', outbounds: names.length ? ['自动选择', ...names, 'direct'] : ['direct'], default: names.length ? '自动选择' : 'direct' },
      ...(names.length ? [{ type: 'urltest', tag: '自动选择', outbounds: names, url: 'https://www.gstatic.com/generate_204', interval: '10m' }] : []),
      ...outs,
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: ['geosite-cn', 'geoip-cn'], outbound: 'direct' },
      ],
      rule_set: [ruleSet('geosite-cn', 'sing-geosite'), ruleSet('geoip-cn', 'sing-geoip')],
      final: '节点选择',
      auto_detect_interface: true,
      default_domain_resolver: 'local',
    },
    experimental: { cache_file: { enabled: true } },
  };
}

function buildSubscription(state, user) {
  const entries = uniqueEntries(userEntries(state, user));
  const links = entries.map((e) => shareLink(state, e, user)).filter(Boolean);
  const proxies = entries.map((e) => clashProxy(state, e, user)).filter(Boolean);
  return {
    v2ray: Buffer.from(links.join('\n')).toString('base64'),
    clash: clashYaml(proxies),
    links,
  };
}

// 推给某台服务器 agent 的用户元数据（流量限制 / 到期 / 订阅内容）
function buildAgentUsers(state, server) {
  const users = usersForServer(state, server);
  return users.map((u) => {
    const local = u.usage?.[server.id] || { up: 0, down: 0 };
    const baseUsed = Math.max(0, userUsedBytes(u) - (local.up || 0) - (local.down || 0));
    const home = homeServerId(state, u);
    return {
      id: u.id,
      name: u.name,
      enabled: !!u.enabled,
      limitBytes: u.limitGB > 0 ? Math.round(u.limitGB * GB) : 0,
      baseUsed,
      baseUsedAt: u.usageAt ? Math.floor(u.usageAt / 1000) : 0,
      expireAt: u.expireAfterDays > 0 ? 0 : (u.expireAt ? Math.floor(u.expireAt / 1000) : 0),
      resetPeriod: u.resetPeriod || 'none',
      resetDay: u.resetDay || 1,
      resetAnchor: Math.floor((u.resetAnchor || u.createdAt || 0) / 1000),
      expireAfterDays: u.expireAfterDays || 0,
      firstUsedAt: u.firstUsedAt ? Math.floor(u.firstUsedAt / 1000) : 0,
      notify: home === server.id && u.id !== 'owner',
    };
  });
}

// 订阅内容推给用户分配到的每一台服务器，任何一台都能提供完整订阅
function buildAgentSubs(state, server) {
  const subs = {};
  for (const u of state.users || []) {
    if (!userHasServer(u, server.id)) continue;
    const sub = buildSubscription(state, u);
    const exp = userExpireAt(u);
    subs[u.token] = {
      userId: u.id,
      name: u.name,
      v2ray: sub.v2ray,
      clash: sub.clash,
      singbox: JSON.stringify(buildSingboxClient(state, u), null, 2),
      url: subscriptionUrl(state, u),
      total: u.limitGB > 0 ? Math.round(u.limitGB * GB) : 0,
      expire: exp ? Math.floor(exp / 1000) : 0,
      expireAfterDays: u.expireAfterDays && !u.firstUsedAt ? u.expireAfterDays : 0,
    };
  }
  return subs;
}

// 用户的"主服务器"：分配到的第一台已部署的服务器（中转机优先级最低），负责发提醒、默认提供订阅
function homeServerId(state, user) {
  const list = (state.servers || []).filter((s) => userHasServer(user, s.id));
  const pick = list.find((s) => s.deployedAt && s.role !== 'relay') || list.find((s) => s.deployedAt) || list[0];
  return pick ? pick.id : null;
}

function subBase(host, port) {
  const h = String(host).trim();
  if (/^https?:\/\//i.test(h)) return h.replace(/\/+$/, ''); // 填了完整地址（如 https://sub.example.com）
  return `http://${hostForUri(h)}:${port}`;
}

// 订阅地址：设置了订阅域名就用域名（换服务器地址不变），否则用主服务器
function subscriptionUrl(state, user) {
  const port = state.settings?.subPort || 2096;
  if (state.settings?.subDomain) return `${subBase(state.settings.subDomain, port)}/sub/${user.token}`;
  const s = (state.servers || []).find((x) => x.id === homeServerId(state, user));
  if (!s) return '';
  return `${subBase(s.host, port)}/sub/${user.token}`;
}

// 备用订阅地址：用户的每台已部署服务器都能提供同样的订阅
function subscriptionUrls(state, user) {
  const port = state.settings?.subPort || 2096;
  return (state.servers || []).filter((s) => s.deployedAt && userHasServer(user, s.id)).map((s) => ({ server: s.name, url: `${subBase(s.host, port)}/sub/${user.token}` }));
}

function serverPorts(state, server) {
  const ports = [];
  const p = server.protocols || {};
  for (const [k, meta] of Object.entries(PROTOCOLS)) if (p[k]?.enabled) ports.push({ port: Number(p[k].port), net: meta.net });
  for (const f of state.forwards || []) {
    if (f.relayServerId !== server.id || f.enabled === false) continue;
    const t = resolveForwardTarget(state, f);
    ports.push({ port: Number(f.listenPort), net: t?.network || 'both' });
  }
  ports.push({ port: Number(state.settings?.subPort || 2096), net: 'tcp' });
  return ports;
}

function checkPortConflicts(state, server) {
  const used = new Map();
  const errs = [];
  for (const { port, net } of serverPorts(state, server)) {
    const nets = net === 'both' || !net ? ['tcp', 'udp'] : [net];
    for (const n of nets) {
      const key = `${n}/${port}`;
      if (used.has(key)) errs.push(`端口冲突：${key}`);
      used.set(key, true);
    }
  }
  return errs;
}

// 给某个协议挑一个不冲突的随机端口（10000-60000，避开 20000-20100 等常见保留段以外不做特殊处理）
function pickFreePort(state, server, protocolKey, avoid = []) {
  const net = PROTOCOLS[protocolKey]?.net || 'tcp';
  const used = new Set();
  for (const { port, net: n } of serverPorts(state, server)) {
    for (const x of (n === 'both' || !n ? ['tcp', 'udp'] : [n])) used.add(`${x}/${port}`);
  }
  for (const p of avoid) used.add(`${net}/${p}`);
  for (let i = 0; i < 200; i++) {
    const port = 10000 + crypto.randomInt(50000);
    if (!used.has(`${net}/${port}`)) return port;
  }
  throw new Error('找不到空闲端口');
}

// 节点被墙后"一键换新"：换端口（固定端口的不换）、Reality 密钥和 short id、VMess 路径
function rotateServer(state, server) {
  const s = JSON.parse(JSON.stringify(server));
  const p = s.protocols || {};
  const changes = [];
  const tmpState = { ...state, servers: (state.servers || []).map((x) => (x.id === s.id ? s : x)) };
  for (const key of Object.keys(PROTOCOLS)) {
    const pc = p[key];
    if (!pc?.enabled) continue;
    if (!pc.fixedPort) {
      const old = pc.port;
      pc.port = 0; // 先腾出旧端口，避免挑到自己
      pc.port = pickFreePort(tmpState, s, key, [old]);
      changes.push(`${PROTOCOLS[key].label} 端口 ${old} → ${pc.port}`);
    }
  }
  if (p.vlessReality?.enabled) {
    const kp = realityKeypair();
    Object.assign(p.vlessReality, { privateKey: kp.privateKey, publicKey: kp.publicKey, shortId: randHex(4) });
    changes.push('Reality 密钥和 short id 已更换');
  }
  if (p.vmess?.enabled) { p.vmess.path = '/' + randId(6); changes.push('VMess 路径已更换'); }
  return { server: s, changes };
}

module.exports = {
  PROTOCOLS, REMOTE_DIR, GB,
  randId, randHex, randPassword, uuid, realityKeypair, defaultProtocols,
  newServer, newUser, userStatus, userExpireAt, homeServerId, subscriptionUrls, buildSingboxClient, uniqueEntries, userUsedBytes, userHasServer, usersForServer,
  buildServerConfig, nodeEntries, shareLink, clashProxy, clientOutbound, clientTestConfig,
  userEntries, buildSubscription, buildAgentUsers, buildAgentSubs, subscriptionUrl,
  serverPorts, checkPortConflicts, resolveForwardTarget, landingOutbound, pickFreePort, rotateServer,
};
