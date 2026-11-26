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
  shadowsocks: { label: 'Shadowsocks-2022', net: 'both', defaultPort: 8388 },
  // 下面两个由 Xray 内核提供（sing-box 不支持 XHTTP）。Xray 收到的流量经本机 socks 交给 sing-box，
  // 落地、WARP 分流、屏蔽 BT / 广告 / 回国等路由规则照样生效
  vlessXhttpReality: { label: 'VLESS-XHTTP-Reality', net: 'tcp', defaultPort: 2053, core: 'xray' },
  vlessXhttpTls: { label: 'VLESS-XHTTP-TLS', net: 'tcp', defaultPort: 2087, core: 'xray' },
};
const XRAY_KEYS = Object.keys(PROTOCOLS).filter((k) => PROTOCOLS[k].core === 'xray');
function isXray(key) { return PROTOCOLS[key]?.core === 'xray'; }
function usesXray(server) { return XRAY_KEYS.some((k) => server?.protocols?.[k]?.enabled); }
// Reality 目标 / 密钥：VLESS-Reality 和 VLESS-XHTTP-Reality 共用一套（存在 protocols.vlessReality 里），巡检和重新优选对两个都生效
function realityOn(server) { const p = server?.protocols || {}; return !!(p.vlessReality?.enabled || p.vlessXhttpReality?.enabled); }

// 协议用到的网络：'both' 表示 TCP 和 UDP 都要
function netsOf(net) { return net === 'both' || !net ? ['tcp', 'udp'] : [net]; }

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
    vlessReality: { enabled: true, port: 443, sni: 'www.microsoft.com', sniAuto: true, fp: 'chrome', privateKey: kp.privateKey, publicKey: kp.publicKey, shortId: randHex(4) },
    trojan: { enabled: true, port: 2083 },
    vmess: { enabled: true, port: 2082, path: '/' + randId(6) },
    hysteria2: { enabled: true, port: 443, upMbps: 0, downMbps: 0 },
    tuic: { enabled: true, port: 8443 },
    anytls: { enabled: true, port: 8443 },
    shadowsocks: { enabled: false, port: 8388, serverKey: crypto.randomBytes(16).toString('base64') },
    vlessXhttpReality: { enabled: false, port: 2053, path: '/' + randId(8) },
    vlessXhttpTls: { enabled: false, port: 2087, path: '/' + randId(8) },
  };
}

// 旧版本数据补齐新协议的默认值
function ensureProtocols(server) {
  const p = server.protocols || (server.protocols = {});
  if (!p.shadowsocks) p.shadowsocks = { enabled: false, port: 8388, serverKey: crypto.randomBytes(16).toString('base64') };
  if (!p.shadowsocks.serverKey) p.shadowsocks.serverKey = crypto.randomBytes(16).toString('base64');
  if (!p.vlessXhttpReality) p.vlessXhttpReality = { enabled: false, port: 2053, path: '/' + randId(8) };
  if (!p.vlessXhttpTls) p.vlessXhttpTls = { enabled: false, port: 2087, path: '/' + randId(8) };
  return server;
}

// SS2022 每个用户的密钥：由用户 UUID 派生（16 字节，base64）
function ssUserKey(user) { return crypto.createHash('sha256').update('nodedeck-ss:' + user.uuid).digest().subarray(0, 16).toString('base64'); }
const SS_METHOD = '2022-blake3-aes-128-gcm';

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
    routing: { blockBT: true, blockAds: false, blockCN: false, warp: { enabled: false, sites: ['openai', 'netflix', 'google', 'disney', 'spotify'] } },
    ipMode: 'v4',
    host6: '',
    domain: '',
    acme: false,
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
  if (landing.type === 'link') {
    const { parseShareLink } = require('./links');
    return parseShareLink(landing.link, tag).outbound;
  }
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

// 用了正式证书（填了域名并开启 ACME）时，客户端用域名做 SNI、不跳过证书验证
function usesAcme(server) { return !!(server.acme && server.domain); }
function tlsSniFor(server) { return usesAcme(server) ? server.domain : (server.tlsSni || 'www.bing.com'); }

function tlsSelfSigned(server, alpn) {
  const t = usesAcme(server)
    ? { enabled: true, server_name: server.domain, certificate_provider: 'acme' }
    : { enabled: true, server_name: server.tlsSni || 'www.bing.com', certificate_path: CERT_PATH, key_path: KEY_PATH };
  if (alpn) t.alpn = alpn;
  return t;
}

// 远程规则集（SagerNet 官方，GitHub 托管；VPS 在境外可以直接下载）。
// sing-box 1.14 起用顶层 http_clients 定义下载用的客户端：不写 detour 就是从本机直连。
// 注意不能写 http_client: { detour: 'direct' }——`check` 能过，但启动时会报
// 「detour to an empty direct outbound makes no sense」直接退出（0.6.0 ~ 0.6.3 的 bug）。
const RULESET_HTTP = 'rule-set';
function remoteRuleSet(tag) {
  const repo = tag.startsWith('geoip-') ? 'sing-geoip' : 'sing-geosite';
  return { type: 'remote', tag, format: 'binary', url: `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${tag}.srs`, http_client: RULESET_HTTP, update_interval: '7d' };
}

const WARP_SITES = {
  openai: { label: 'ChatGPT / OpenAI', sets: ['geosite-openai'] },
  anthropic: { label: 'Claude', sets: ['geosite-anthropic'] },
  google: { label: 'Google / Gemini', sets: ['geosite-google'] },
  netflix: { label: 'Netflix', sets: ['geosite-netflix'] },
  disney: { label: 'Disney+', sets: ['geosite-disney'] },
  spotify: { label: 'Spotify', sets: ['geosite-spotify'] },
  tiktok: { label: 'TikTok', sets: ['geosite-tiktok'] },
};

// ---------- 服务端配置 ----------
// opts.includeInactive: agent 需要完整配置（含已停用用户），由 agent 自己过滤；默认 true
function buildServerConfig(state, server, opts = {}) {
  ensureProtocols(server);
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
    if (p.hysteria2.obfs) ib.obfs = { type: 'salamander', password: p.hysteria2.obfs };
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

  if (p.shadowsocks?.enabled) {
    inbounds.push({
      type: 'shadowsocks', tag: 'ss-in', listen, listen_port: Number(p.shadowsocks.port),
      method: SS_METHOD, password: p.shadowsocks.serverKey,
      users: users.map((u) => ({ name: u.id, password: ssUserKey(u) })),
    });
  }

  // Xray（XHTTP 协议）收到的流量从这里进 sing-box：只监听本机，后面的路由规则、落地、WARP 都照常
  if (usesXray(server)) inbounds.push({ type: 'socks', tag: 'xray-in', listen: '127.0.0.1', listen_port: xrayPorts(state).bridge });

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

  // 路由规则：屏蔽 BT / 广告 / 回国流量，指定网站走 WARP
  const rt = server.routing || {};
  const ruleSets = new Set();
  if (rt.blockBT) rules.push({ protocol: 'bittorrent', action: 'reject' });
  if (rt.blockAds) { rules.push({ rule_set: ['geosite-category-ads-all'], action: 'reject' }); ruleSets.add('geosite-category-ads-all'); }
  if (rt.blockCN) { rules.push({ rule_set: ['geosite-cn', 'geoip-cn'], action: 'reject' }); ruleSets.add('geosite-cn'); ruleSets.add('geoip-cn'); }
  const endpoints = [];
  const w = server.warp;
  if (rt.warp?.enabled && w?.privateKey) {
    endpoints.push({
      type: 'wireguard', tag: 'warp', mtu: 1280,
      address: [w.address4 && `${w.address4}/32`, w.address6 && `${w.address6}/128`].filter(Boolean),
      private_key: w.privateKey,
      peers: [{ address: w.endpointHost || '162.159.192.1', port: Number(w.endpointPort) || 2408, public_key: w.peerPublicKey, allowed_ips: ['0.0.0.0/0', '::/0'], reserved: w.reserved || [0, 0, 0] }],
    });
    const sets = (rt.warp.sites || []).flatMap((k) => WARP_SITES[k]?.sets || []);
    if (sets.length) { rules.push({ rule_set: sets, outbound: 'warp' }); sets.forEach((x) => ruleSets.add(x)); }
  }

  const config = {
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
  if (endpoints.length) config.endpoints = endpoints;
  if (ruleSets.size) {
    config.http_clients = [{ tag: RULESET_HTTP }];
    config.route.rule_set = [...ruleSets].map(remoteRuleSet);
    config.experimental.cache_file = { enabled: true, path: `${REMOTE_DIR}/cache.db` };
  }
  if (usesAcme(server)) {
    config.certificate_providers = [{
      type: 'acme', tag: 'acme', domain: [server.domain], data_directory: `${REMOTE_DIR}/acme`,
      email: server.acmeEmail || undefined, disable_tls_alpn_challenge: true,
    }];
  }
  return config;
}

// ---------- Xray（XHTTP） ----------
function xrayPorts(state) {
  const st = state.settings || {};
  return { api: Number(st.xrayStatsPort) || 9093, bridge: Number(st.xrayBridgePort) || 9094 };
}
// 正式证书由 sing-box 申请（certmagic 存储格式），Xray 直接读同一份文件；证书续期后 agent 会重启 Xray
function acmeCertFiles(server) {
  const d = `${REMOTE_DIR}/acme/certificates/acme-v02.api.letsencrypt.org-directory/${server.domain}`;
  return { cert: `${d}/${server.domain}.crt`, key: `${d}/${server.domain}.key` };
}
function xhttpPath(pc) { const v = String(pc?.path || '/').trim(); return v.startsWith('/') ? v : '/' + v; }

// Xray 服务端配置；没开 XHTTP 协议返回 null。用户的 email 字段放用户 id，agent 按它统计流量、停用超额用户
function buildXrayConfig(state, server, opts = {}) {
  ensureProtocols(server);
  if (!usesXray(server)) return null;
  const includeInactive = opts.includeInactive !== false;
  const users = usersForServer(state, server).filter((u) => includeInactive || userStatus(u).active);
  const p = server.protocols;
  const ports = xrayPorts(state);
  const clients = users.map((u) => ({ id: u.uuid, email: u.id }));
  const inbounds = [];
  const sniffing = { enabled: false }; // 嗅探交给 sing-box
  if (p.vlessXhttpReality?.enabled) {
    const r = p.vlessReality;
    inbounds.push({
      tag: 'xhttp-reality-in', port: Number(p.vlessXhttpReality.port), protocol: 'vless',
      settings: { clients, decryption: 'none' },
      streamSettings: {
        network: 'xhttp', xhttpSettings: { path: xhttpPath(p.vlessXhttpReality), mode: 'auto' },
        security: 'reality',
        realitySettings: { target: `${r.sni}:443`, serverNames: [r.sni], privateKey: r.privateKey, shortIds: [r.shortId] },
      },
      sniffing,
    });
  }
  if (p.vlessXhttpTls?.enabled) {
    const files = usesAcme(server) ? acmeCertFiles(server) : { cert: CERT_PATH, key: KEY_PATH };
    inbounds.push({
      tag: 'xhttp-tls-in', port: Number(p.vlessXhttpTls.port), protocol: 'vless',
      settings: { clients, decryption: 'none' },
      streamSettings: {
        network: 'xhttp', xhttpSettings: { path: xhttpPath(p.vlessXhttpTls), mode: 'auto' },
        security: 'tls',
        tlsSettings: { alpn: ['h2', 'http/1.1'], certificates: [{ certificateFile: files.cert, keyFile: files.key }] },
      },
      sniffing,
    });
  }
  return {
    log: { loglevel: 'warning' },
    api: { tag: 'api', listen: `127.0.0.1:${ports.api}`, services: ['StatsService'] },
    stats: {},
    policy: { levels: { 0: { statsUserUplink: true, statsUserDownlink: true } } },
    inbounds,
    outbounds: [{ tag: 'sing-box', protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port: ports.bridge }] } }],
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
// Cloudflare 隧道配置（需要启用 VMess-WS、填了令牌和域名才算生效）
function cfTunnelOf(server) {
  const t = server.cfTunnel;
  if (!t?.enabled || !t.token || !t.hostname || !server.protocols?.vmess?.enabled) return null;
  return { token: t.token.trim(), hostname: t.hostname.trim(), cdnHosts: (t.cdnHosts || []).map((x) => String(x).trim()).filter(Boolean) };
}

// Cloudflare 隧道单独跑一个 sing-box 进程（nodedeck-cf 服务）：令牌错了或连不上 Cloudflare 时
// 只影响隧道本身，不会把主服务拖垮。隧道里进来的连接按 Cloudflare 后台配置的 localhost:端口 直连本机 VMess-WS。
function buildTunnelConfig(server) {
  const cft = cfTunnelOf(server);
  if (!cft) return null;
  return {
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'cloudflared', tag: 'cf-in', token: cft.token }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
  };
}

// 服务器的入口地址：只 IPv4 / 双栈 / 只 IPv6（没填 IPv6 地址时自动退回 IPv4）
function serverHosts(server) {
  const mode = server.ipMode || 'v4';
  const v6 = String(server.host6 || '').trim();
  if (mode === 'v6only' && v6) return [{ host: v6, suffix: '-v6' }];
  const list = [{ host: server.host, suffix: '' }];
  if (mode === 'dual' && v6) list.push({ host: v6, suffix: '-v6' });
  return list;
}

function nodeEntries(state, server) {
  const out = [];
  const p = server.protocols || {};
  for (const { host, suffix } of serverHosts(server)) {
    for (const key of Object.keys(PROTOCOLS)) {
      if (!p[key]?.enabled) continue;
      out.push({ serverId: server.id, protocol: key, host, port: Number(p[key].port), label: `${server.name}-${PROTOCOLS[key].label}${suffix}` });
    }
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
  const cft = cfTunnelOf(server);
  if (cft) {
    out.push({ serverId: server.id, protocol: 'vmess', host: cft.hostname, port: 443, label: `${server.name}-CF隧道`, cf: cft.hostname });
    for (const h of cft.cdnHosts) out.push({ serverId: server.id, protocol: 'vmess', host: h, port: 443, label: `${server.name}-CF优选-${h}`, cf: cft.hostname });
  }
  return out;
}

function hostForUri(h) { return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h; }

// Hysteria2 端口跳跃范围，如 "20000-30000"；经中转的入口不跳跃
function hopRange(server, entry) {
  const r = String(server.protocols?.hysteria2?.hopPorts || '').trim();
  const m = r.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!m || entry.via) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a > 0 && b > a && b <= 65535 ? [a, b] : null;
}

// Reality 目标备选：找不到同网段邻居时，从这些大站里挑 VPS 连得最快的。
// 不放 Google 系（国内按 SNI 阻断）和 Cloudflare（CDN，不像真实站点）
// 在国内按域名（SNI）屏蔽的网站，不能当 Reality 目标 / 自签证书域名（和 agent/reality.go 的 blockedSNI 一致）
const SNI_BLOCKED = ['google.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com', 'youtube.com', 'ytimg.com', 'facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com', 'whatsapp.net', 'twitter.com', 'x.com', 'twimg.com', 'telegram.org', 't.me', 'wikipedia.org', 'wikimedia.org', 'netflix.com', 'reddit.com', 'discord.com', 'discord.gg', 'pinterest.com', 'dropbox.com', 'openai.com', 'chatgpt.com', 'blogspot.com', 'nytimes.com', 'medium.com', 'github.io', 'pornhub.com', 'xvideos.com', 'onlyfans.com', 'bbc.com', 'voanews.com', 'rfa.org', 'theepochtimes.com', 'ntdtv.com'];
function sniBlocked(d) {
  d = String(d || '').toLowerCase().replace(/\.$/, '');
  return SNI_BLOCKED.some((b) => d === b || d.endsWith('.' + b));
}

const REALITY_FALLBACKS = ['www.microsoft.com', 'www.apple.com', 'www.amazon.com', 'www.nvidia.com', 'www.samsung.com', 'www.tesla.com', 'www.oracle.com', 'www.cisco.com', 'addons.mozilla.org'];

// TCP 协议的优先端口：443 最自然，其次是常见的 HTTPS 备用端口
const PREFERRED_TCP_PORTS = [443, 8443, 2053, 2083, 2087, 2096];

// 客户端 TLS 指纹（Reality 用）。一键换新时会随机换一个
const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'edge'];
function fpOf(pc) { return FINGERPRINTS.includes(pc?.fp) ? pc.fp : 'chrome'; }

// 自签证书的 SHA-256 指纹（hex，小写、无冒号）。v2rayNG 2.x（Xray 26）已经删掉了「跳过证书验证」，
// 自签证书必须带指纹才能连：Hysteria2 链接用 pinSHA256，其它协议用 pcs。正式证书不需要。
function certPinOf(server) {
  if (usesAcme(server)) return '';
  const h = String(server.certSha256 || '').replace(/:/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : '';
}

// 链接参数统一在这里编码，避免漏掉特殊字符
function qs(obj) {
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

function shareLink(state, entry, user) {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const host = hostForUri(entry.host);
  const port = entry.port;
  const name = encodeURIComponent(entry.label);
  const sni = tlsSniFor(server);
  const ins = usesAcme(server) ? 0 : 1;
  const pin = certPinOf(server);
  const pw = encodeURIComponent(user.password);
  switch (entry.protocol) {
    case 'vlessReality':
      return `vless://${user.uuid}@${host}:${port}?${qs({ encryption: 'none', flow: 'xtls-rprx-vision', security: 'reality', sni: pc.sni, fp: fpOf(pc), pbk: pc.publicKey, sid: pc.shortId, type: 'tcp' })}#${name}`;
    case 'trojan':
      return `trojan://${pw}@${host}:${port}?${qs({ security: 'tls', sni, allowInsecure: ins, pcs: pin, type: 'tcp' })}#${name}`;
    case 'vmess': {
      const j = { v: '2', ps: entry.label, add: entry.host, port: String(port), id: user.uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: entry.cf || '', path: pc.path || '/', tls: entry.cf ? 'tls' : '' };
      if (entry.cf) { j.sni = entry.cf; j.fp = 'chrome'; }
      return 'vmess://' + Buffer.from(JSON.stringify(j)).toString('base64');
    }
    case 'hysteria2': {
      const hop = hopRange(server, entry);
      const q = { sni, insecure: ins, pinSHA256: pin };
      if (pc.obfs) Object.assign(q, { obfs: 'salamander', 'obfs-password': pc.obfs });
      if (hop) q.mport = `${hop[0]}-${hop[1]}`;
      return `hysteria2://${pw}@${host}:${port}/?${qs(q)}#${name}`;
    }
    case 'tuic':
      return `tuic://${user.uuid}:${pw}@${host}:${port}?${qs({ congestion_control: 'bbr', alpn: 'h3', sni, allow_insecure: ins, pcs: pin, udp_relay_mode: 'native' })}#${name}`;
    case 'anytls':
      return `anytls://${pw}@${host}:${port}?${qs({ sni, insecure: ins, pcs: pin })}#${name}`;
    case 'shadowsocks': {
      const ui = Buffer.from(`${SS_METHOD}:${pc.serverKey}:${ssUserKey(user)}`).toString('base64');
      return `ss://${ui}@${host}:${port}#${name}`;
    }
    // XHTTP：Reality 用 stream-one（部分客户端 auto 模式下经 Reality 会断），TLS 用 auto
    case 'vlessXhttpReality': {
      const r = server.protocols.vlessReality;
      return `vless://${user.uuid}@${host}:${port}?${qs({ encryption: 'none', security: 'reality', sni: r.sni, fp: fpOf(r), pbk: r.publicKey, sid: r.shortId, type: 'xhttp', path: xhttpPath(pc), mode: 'stream-one' })}#${name}`;
    }
    case 'vlessXhttpTls':
      // 有指纹就只带 pcs（Xray 26 已删掉 allowInsecure，带上反而可能让新客户端报错）
      return `vless://${user.uuid}@${host}:${port}?${qs({ encryption: 'none', security: 'tls', sni, fp: 'chrome', alpn: 'h2,http/1.1', allowInsecure: pin ? undefined : ins, pcs: pin, type: 'xhttp', path: xhttpPath(pc), mode: 'auto' })}#${name}`;
    default:
      return '';
  }
}

function clashProxy(state, entry, user) {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const base = { name: entry.label, server: entry.host, port: entry.port };
  const sni = tlsSniFor(server);
  const skip = !usesAcme(server);
  const pin = certPinOf(server);
  const pinned = (o) => (pin ? { ...o, fingerprint: pin } : o); // mihomo 按证书指纹校验自签证书
  switch (entry.protocol) {
    case 'vlessReality':
      return { ...base, type: 'vless', uuid: user.uuid, network: 'tcp', tls: true, udp: true, flow: 'xtls-rprx-vision', servername: pc.sni, 'client-fingerprint': fpOf(pc), 'reality-opts': { 'public-key': pc.publicKey, 'short-id': pc.shortId } };
    case 'trojan':
      return pinned({ ...base, type: 'trojan', password: user.password, sni, 'skip-cert-verify': skip, udp: true });
    case 'vmess':
      if (entry.cf) return { ...base, type: 'vmess', uuid: user.uuid, alterId: 0, cipher: 'auto', network: 'ws', tls: true, servername: entry.cf, 'client-fingerprint': 'chrome', 'ws-opts': { path: pc.path || '/', headers: { Host: entry.cf } }, udp: true };
      return { ...base, type: 'vmess', uuid: user.uuid, alterId: 0, cipher: 'auto', network: 'ws', 'ws-opts': { path: pc.path || '/' }, udp: true };
    case 'hysteria2': {
      const o = pinned({ ...base, type: 'hysteria2', password: user.password, sni, 'skip-cert-verify': skip });
      if (pc.obfs) { o.obfs = 'salamander'; o['obfs-password'] = pc.obfs; }
      const hop = hopRange(server, entry);
      if (hop) o.ports = `${hop[0]}-${hop[1]}`;
      return o;
    }
    case 'tuic':
      return pinned({ ...base, type: 'tuic', uuid: user.uuid, password: user.password, sni, alpn: ['h3'], 'skip-cert-verify': skip, 'congestion-controller': 'bbr', 'udp-relay-mode': 'native' });
    case 'anytls':
      return pinned({ ...base, type: 'anytls', password: user.password, sni, 'skip-cert-verify': skip, udp: true, 'client-fingerprint': 'chrome' });
    case 'shadowsocks':
      return { ...base, type: 'ss', cipher: SS_METHOD, password: `${pc.serverKey}:${ssUserKey(user)}`, udp: true };
    // mihomo 1.19.13 起支持 XHTTP；更老的 Clash 内核由 agent 按 UA 去掉这两个节点
    case 'vlessXhttpReality': {
      const r = server.protocols.vlessReality;
      return { ...base, type: 'vless', uuid: user.uuid, network: 'xhttp', tls: true, udp: true, servername: r.sni, 'client-fingerprint': fpOf(r), 'reality-opts': { 'public-key': r.publicKey, 'short-id': r.shortId }, 'xhttp-opts': { path: xhttpPath(pc), mode: 'stream-one' } };
    }
    case 'vlessXhttpTls':
      return pinned({ ...base, type: 'vless', uuid: user.uuid, network: 'xhttp', tls: true, udp: true, servername: sni, alpn: ['h2', 'http/1.1'], 'client-fingerprint': 'chrome', 'skip-cert-verify': skip, 'xhttp-opts': { path: xhttpPath(pc), mode: 'auto' } });
    default:
      return null;
  }
}

// Xray 客户端出站（本地测试 XHTTP 节点用；sing-box 客户端不支持 XHTTP）
function xrayClientOutbound(state, entry, user) {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const vnext = { address: entry.host, port: entry.port, users: [{ id: user.uuid, encryption: 'none' }] };
  const out = { tag: 'proxy', protocol: 'vless', settings: { vnext: [vnext] } };
  if (entry.protocol === 'vlessXhttpReality') {
    const r = server.protocols.vlessReality;
    out.streamSettings = { network: 'xhttp', xhttpSettings: { path: xhttpPath(pc), mode: 'stream-one' }, security: 'reality', realitySettings: { serverName: r.sni, fingerprint: fpOf(r), publicKey: r.publicKey, shortId: r.shortId } };
    return out;
  }
  if (entry.protocol === 'vlessXhttpTls') {
    const tls = { serverName: tlsSniFor(server), fingerprint: 'chrome', alpn: ['h2', 'http/1.1'] };
    const pin = certPinOf(server);
    // Xray 26 起删掉了 allowInsecure，自签证书只能按指纹（pinnedPeerCertSha256）校验
    if (pin) tls.pinnedPeerCertSha256 = pin;
    else if (!usesAcme(server)) throw new Error('还没拿到这台服务器的自签证书指纹，先「同步」一次再测');
    out.streamSettings = { network: 'xhttp', xhttpSettings: { path: xhttpPath(pc), mode: 'auto' }, security: 'tls', tlsSettings: tls };
    return out;
  }
  return null;
}
function xrayTestConfig(outbound, httpPort) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'http-in', listen: '127.0.0.1', port: httpPort, protocol: 'http' }],
    outbounds: [outbound],
  };
}

// sing-box 客户端出站（本地节点测试、sing-box 订阅）
function clientOutbound(state, entry, user, tag = 'proxy') {
  const server = state.servers.find((s) => s.id === entry.serverId);
  const pc = server.protocols[entry.protocol];
  const base = { tag, server: entry.host, server_port: entry.port };
  const sni = tlsSniFor(server);
  // 自签证书：有公钥指纹就按指纹校验（防中间人），没有才退回跳过校验。旧版 sing-box 客户端由 agent 按 UA 降级
  const spki = !usesAcme(server) && /^[A-Za-z0-9+/]{43}=$/.test(server.certSpki || '') ? server.certSpki : '';
  const tlsOf = (alpn) => ({ enabled: true, server_name: sni, ...(usesAcme(server) ? {} : spki ? { certificate_public_key_sha256: [spki] } : { insecure: true }), ...(alpn ? { alpn } : {}) });
  switch (entry.protocol) {
    case 'vlessReality':
      return { ...base, type: 'vless', uuid: user.uuid, flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: pc.sni, utls: { enabled: true, fingerprint: fpOf(pc) }, reality: { enabled: true, public_key: pc.publicKey, short_id: pc.shortId } } };
    case 'trojan':
      return { ...base, type: 'trojan', password: user.password, tls: tlsOf() };
    case 'vmess':
      if (entry.cf) return { ...base, type: 'vmess', uuid: user.uuid, security: 'auto', alter_id: 0, tls: { enabled: true, server_name: entry.cf, utls: { enabled: true, fingerprint: 'chrome' } }, transport: { type: 'ws', path: pc.path || '/', headers: { Host: entry.cf } } };
      return { ...base, type: 'vmess', uuid: user.uuid, security: 'auto', alter_id: 0, transport: { type: 'ws', path: pc.path || '/' } };
    case 'hysteria2': {
      const o = { ...base, type: 'hysteria2', password: user.password, tls: tlsOf(['h3']) };
      if (pc.obfs) o.obfs = { type: 'salamander', password: pc.obfs };
      const hop = hopRange(server, entry);
      if (hop) { o.server_ports = [`${hop[0]}:${hop[1]}`]; o.hop_interval = '30s'; }
      return o;
    }
    case 'tuic':
      return { ...base, type: 'tuic', uuid: user.uuid, password: user.password, congestion_control: 'bbr', tls: tlsOf(['h3']) };
    case 'anytls':
      return { ...base, type: 'anytls', password: user.password, tls: tlsOf() };
    case 'shadowsocks':
      return { ...base, type: 'shadowsocks', method: SS_METHOD, password: `${pc.serverKey}:${ssUserKey(user)}` };
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

// 防 DNS 泄露：开 DNS 模块用 fake-ip，国外域名经节点用加密 DNS 查（respect-rules），国内域名用国内加密 DNS；
// 规则先按域名分流，按 IP 分流时不在本地解析（no-resolve），这样本地运营商的 DNS 看不到你访问的国外网站。
// TUN 段默认关，客户端里打开 TUN 后所有流量（包括浏览器 WebRTC 的 UDP）都走代理，防真实 IP 泄露。
const CLASH_DNS = [
  'dns:',
  '  enable: true',
  '  ipv6: false',
  '  enhanced-mode: fake-ip',
  '  fake-ip-range: 198.18.0.1/16',
  '  fake-ip-filter: ' + JSON.stringify(['*.lan', '*.local', 'localhost', '+.msftconnecttest.com', '+.msftncsi.com', 'time.*.com', '+.ntp.org', '+.pool.ntp.org']),
  '  respect-rules: true',
  '  default-nameserver: ' + JSON.stringify(['223.5.5.5', '119.29.29.29']),
  '  proxy-server-nameserver: ' + JSON.stringify(['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query']),
  '  nameserver: ' + JSON.stringify(['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query']),
  '  nameserver-policy:',
  "    'geosite:cn,private': " + JSON.stringify(['https://223.5.5.5/dns-query', 'https://1.12.12.12/dns-query']),
  'tun:',
  '  enable: false',
  '  stack: mixed',
  '  auto-route: true',
  '  auto-detect-interface: true',
  '  strict-route: true',
  '  dns-hijack: ' + JSON.stringify(['any:53', 'tcp://any:53']),
];

function clashYaml(proxies) {
  const names = proxies.map((p) => p.name);
  const lines = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'ipv6: true',
    'unified-delay: true',
    ...CLASH_DNS,
    'proxies:',
    ...proxies.map((p) => '  - ' + toYamlValue(p)),
    'proxy-groups:',
    '  - ' + toYamlValue({ name: '节点选择', type: 'select', proxies: ['自动选择', ...names] }),
    '  - ' + toYamlValue({ name: '自动选择', type: 'url-test', url: 'https://www.gstatic.com/generate_204', interval: 300, proxies: names.length ? names : ['DIRECT'] }),
    'rules:',
    '  - GEOSITE,private,DIRECT',
    '  - GEOSITE,cn,DIRECT',
    '  - GEOIP,private,DIRECT,no-resolve',
    '  - GEOIP,CN,DIRECT,no-resolve',
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
  const out = {
    v2ray: Buffer.from(links.join('\n')).toString('base64'),
    clash: clashYaml(proxies),
    links,
  };
  // 老版 Clash 内核不认识 XHTTP：另备一份不含 XHTTP 节点的，agent 按客户端 UA 挑
  const legacy = proxies.filter((p) => p.network !== 'xhttp');
  if (legacy.length !== proxies.length) out.clashLegacy = clashYaml(legacy);
  return out;
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
      clashLegacy: sub.clashLegacy || '',
      singbox: JSON.stringify(buildSingboxClient(state, u), null, 2),
      url: subscriptionUrl(state, u),
      total: u.limitGB > 0 ? Math.round(u.limitGB * GB) : 0,
      expire: exp ? Math.floor(exp / 1000) : 0,
      expireAfterDays: u.expireAfterDays && !u.firstUsedAt ? u.expireAfterDays : 0,
    };
    // 临时订阅链接：内容一样，到期后 VPS 返回 410
    for (const t of u.tempSubs || []) {
      if (t.validUntil > Date.now()) subs[t.token] = { ...subs[u.token], url: subscriptionUrl(state, { ...u, token: t.token }), validUntil: Math.floor(t.validUntil / 1000) };
    }
  }
  return subs;
}

// 用户的"主服务器"：分配到的第一台已部署的服务器（中转机优先级最低），负责发提醒、默认提供订阅
function homeServerId(state, user) {
  const list = (state.servers || []).filter((s) => userHasServer(user, s.id));
  const pick = list.find((s) => s.deployedAt && s.role !== 'relay') || list.find((s) => s.deployedAt) || list[0];
  return pick ? pick.id : null;
}

function subBase(host, port, https = false) {
  const h = String(host).trim();
  if (/^https?:\/\//i.test(h)) return h.replace(/\/+$/, ''); // 填了完整地址（如 https://sub.example.com）
  return `${https ? 'https' : 'http'}://${hostForUri(h)}:${port}`;
}

// 订阅走 HTTPS（不用域名）：设置里没关、也没填订阅域名时，agent 给 VPS 的 IP 申请 Let's Encrypt 证书
function subTlsWanted(state) { return state.settings?.subHttps !== false && !state.settings?.subDomain; }
// 这台服务器的订阅证书现在能用（agent 报告有效、对得上地址、还有至少 1 小时）
function subCertOk(state, s) {
  const c = s?.lastStatus?.subCert;
  return !!(subTlsWanted(state) && c && c.ok && c.notAfter > Date.now() + 3600e3 && String(c.host || '') === String(s.host || '').replace(/^\[|\]$/g, ''));
}

// 订阅地址：设置了订阅域名就用域名（换服务器地址不变），否则用主服务器
function subscriptionUrl(state, user) {
  const port = state.settings?.subPort || 2096;
  if (state.settings?.subDomain) return `${subBase(state.settings.subDomain, port)}/sub/${user.token}`;
  const s = (state.servers || []).find((x) => x.id === homeServerId(state, user));
  if (!s) return '';
  return `${subBase(s.host, port, subCertOk(state, s))}/sub/${user.token}`;
}

// 备用订阅地址：用户的每台已部署服务器都能提供同样的订阅
function subscriptionUrls(state, user) {
  const port = state.settings?.subPort || 2096;
  return (state.servers || []).filter((s) => s.deployedAt && userHasServer(user, s.id)).map((s) => ({ server: s.name, url: `${subBase(s.host, port, subCertOk(state, s))}/sub/${user.token}` }));
}

function serverPorts(state, server) {
  const ports = [];
  const p = server.protocols || {};
  for (const [k, meta] of Object.entries(PROTOCOLS)) if (p[k]?.enabled) ports.push({ port: Number(p[k].port), net: meta.net, key: k });
  const hop = p.hysteria2?.enabled ? hopRange(server, {}) : null;
  if (hop) ports.push({ range: hop, net: 'udp' });
  if (usesAcme(server)) ports.push({ port: 80, net: 'tcp', acme: true });
  else if (subTlsWanted(state)) ports.push({ port: 80, net: 'tcp', acme: true }); // 订阅证书的 http-01 验证（只在验证时临时监听）
  for (const f of state.forwards || []) {
    if (f.relayServerId !== server.id || f.enabled === false) continue;
    const t = resolveForwardTarget(state, f);
    ports.push({ port: Number(f.listenPort), net: t?.network || 'both' });
  }
  ports.push({ port: Number(state.settings?.subPort || 2096), net: 'both' }); // UDP 用于测丢包（带口令的回显）
  return ports;
}

function checkPortConflicts(state, server) {
  const used = new Map();
  const errs = [];
  const ranges = [];
  for (const { port, net, range } of serverPorts(state, server)) {
    if (range) { ranges.push(range); continue; }
    for (const n of netsOf(net)) {
      const key = `${n}/${port}`;
      if (used.has(key)) errs.push(`端口冲突：${key}`);
      used.set(key, true);
    }
  }
  for (const [a, b] of ranges) {
    for (const key of used.keys()) {
      const [n, pt] = key.split('/');
      if (n === 'udp' && Number(pt) >= a && Number(pt) <= b) errs.push(`Hysteria2 端口跳跃范围 ${a}-${b} 包含了 UDP 端口 ${pt}`);
    }
  }
  return errs;
}

// 给某个协议挑一个不冲突的随机端口（10000-60000，避开 20000-20100 等常见保留段以外不做特殊处理）
function pickFreePort(state, server, protocolKey, avoid = []) {
  const net = PROTOCOLS[protocolKey]?.net || 'tcp';
  const used = new Set();
  const ranges = [];
  for (const { port, net: n, range } of serverPorts(state, server)) {
    if (range) { ranges.push(range); continue; }
    for (const x of netsOf(n)) used.add(`${x}/${port}`);
  }
  for (const p of avoid) for (const x of netsOf(net)) used.add(`${x}/${p}`);
  for (let i = 0; i < 200; i++) {
    const port = 10000 + crypto.randomInt(50000);
    if (netsOf(net).some((x) => used.has(`${x}/${port}`))) continue;
    if (ranges.some(([a, b]) => port >= a && port <= b)) continue;
    return port;
  }
  throw new Error('找不到空闲端口');
}

// 在优先端口里挑一个没被本服务器其它协议、端口跳跃范围和 extraUsed（VPS 上被别的程序占用的端口）用掉的
function pickPreferredPort(state, server, protocolKey, extraUsed = []) {
  const net = PROTOCOLS[protocolKey]?.net || 'tcp';
  const used = new Set(extraUsed.map((p) => `tcp/${p}`));
  const ranges = [];
  for (const { port, net: n, range, key } of serverPorts(state, server)) {
    if (key === protocolKey) continue;
    if (range) { ranges.push(range); continue; }
    for (const x of netsOf(n)) used.add(`${x}/${port}`);
  }
  return PREFERRED_TCP_PORTS.find((port) => !netsOf(net).some((x) => used.has(`${x}/${port}`)) && !ranges.some(([a, b]) => port >= a && port <= b)) || 0;
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
    if (!pc.fixedPort && !(key === 'vmess' && cfTunnelOf(s))) {
      const old = pc.port;
      pc.port = 0; // 先腾出旧端口，避免挑到自己
      pc.port = pickFreePort(tmpState, s, key, [old]);
      changes.push(`${PROTOCOLS[key].label} 端口 ${old} → ${pc.port}`);
    }
  }
  if (realityOn(s)) {
    const kp = realityKeypair();
    const fp = FINGERPRINTS.filter((x) => x !== fpOf(p.vlessReality))[crypto.randomInt(FINGERPRINTS.length - 1)];
    Object.assign(p.vlessReality, { privateKey: kp.privateKey, publicKey: kp.publicKey, shortId: randHex(4), fp });
    changes.push(`Reality 密钥、short id 已更换，客户端指纹改为 ${fp}`);
  }
  if (p.vmess?.enabled) { p.vmess.path = '/' + randId(6); changes.push('VMess 路径已更换'); }
  for (const k of XRAY_KEYS) if (p[k]?.enabled) { p[k].path = '/' + randId(8); changes.push(`${PROTOCOLS[k].label} 路径已更换`); }
  if (p.shadowsocks?.enabled) { p.shadowsocks.serverKey = crypto.randomBytes(16).toString('base64'); changes.push('Shadowsocks 密钥已更换'); }
  if (p.hysteria2?.enabled && p.hysteria2.obfs) { p.hysteria2.obfs = randPassword(16); changes.push('Hysteria2 混淆密码已更换'); }
  return { server: s, changes };
}

module.exports = {
  PROTOCOLS, REMOTE_DIR, GB, hostForUri, subBase,
  randId, randHex, randPassword, uuid, realityKeypair, defaultProtocols,
  newServer, newUser, userStatus, userExpireAt, homeServerId, subscriptionUrls, buildSingboxClient, uniqueEntries, userUsedBytes, userHasServer, usersForServer,
  buildServerConfig, nodeEntries, shareLink, clashProxy, clientOutbound, clientTestConfig,
  userEntries, buildSubscription, buildAgentUsers, buildAgentSubs, subscriptionUrl,
  XRAY_KEYS, isXray, usesXray, realityOn, xrayPorts, buildXrayConfig, xrayClientOutbound, xrayTestConfig, acmeCertFiles, xhttpPath,
  SNI_BLOCKED, sniBlocked, netsOf, subTlsWanted, subCertOk, serverPorts, checkPortConflicts, resolveForwardTarget, landingOutbound, pickFreePort, rotateServer,
  netsOf, ensureProtocols, ssUserKey, cfTunnelOf, buildTunnelConfig, certPinOf, fpOf, FINGERPRINTS, REALITY_FALLBACKS, PREFERRED_TCP_PORTS, pickPreferredPort, usesAcme, tlsSniFor, hopRange, serverHosts, WARP_SITES,
};
