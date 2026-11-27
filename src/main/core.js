'use strict';
// 纯逻辑模块：不依赖 Electron，便于测试。
// 负责：协议定义、用户、sing-box / Xray 服务端配置、端口分配、一键换新。
// 节点入口、分享链接、订阅、客户端出站在 subscribe.js（从这里一起导出）。

const crypto = require('crypto');

const REMOTE_DIR = '/etc/nodedeck';
const CONN_LOG = `${REMOTE_DIR}/conn.log`;
const XRAY_ACCESS_LOG = `${REMOTE_DIR}/xray-access.log`;
// 统计每个用户在用的设备数（默认开）
const onlineTrackOn = (state) => state?.settings?.onlineTrack !== false;
const CERT_PATH = `${REMOTE_DIR}/cert.pem`;
const KEY_PATH = `${REMOTE_DIR}/key.pem`;

const PROTOCOLS = {
  vlessReality: { label: 'VLESS-Reality', net: 'tcp', defaultPort: 2053 },
  trojan: { label: 'Trojan', net: 'tcp', defaultPort: 2083 },
  vmess: { label: 'VMess-WS', net: 'tcp', defaultPort: 2082 },
  hysteria2: { label: 'Hysteria2', net: 'udp', defaultPort: 2053 },
  tuic: { label: 'TUIC', net: 'udp', defaultPort: 2083 },
  anytls: { label: 'AnyTLS', net: 'tcp', defaultPort: 2086 },
  shadowsocks: { label: 'Shadowsocks-2022', net: 'both', defaultPort: 8388 },
  // 下面两个由 Xray 内核提供（sing-box 不支持 XHTTP）。Xray 收到的流量经本机 socks 交给 sing-box，
  // 落地、WARP 分流、屏蔽 BT / 广告 / 回国等路由规则照样生效
  vlessXhttpReality: { label: 'VLESS-XHTTP-Reality', net: 'tcp', defaultPort: 2052, core: 'xray' },
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
    vlessReality: { enabled: true, port: 2053, sni: 'www.microsoft.com', sniAuto: true, fp: 'chrome', privateKey: kp.privateKey, publicKey: kp.publicKey, shortId: randHex(4) },
    trojan: { enabled: true, port: 2083 },
    vmess: { enabled: true, port: 2082, path: '/' + randId(6) },
    hysteria2: { enabled: true, port: 2053, upMbps: 0, downMbps: 0 },
    tuic: { enabled: true, port: 2083 },
    anytls: { enabled: true, port: 2086 },
    shadowsocks: { enabled: false, port: 8388, serverKey: crypto.randomBytes(16).toString('base64') },
    vlessXhttpReality: { enabled: false, port: 2052, path: '/' + randId(8) },
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

  // 本机作为中转的端口转发由 agent 做（0.9.3 起；见 agentForwards），不再占 sing-box 的入站

  // 出站：直连或经住宅落地；流量统计由 V2Ray API 按用户计数（需要 with_v2ray_api 构建）
  const outbounds = [{ type: 'direct', tag: 'direct' }];
  let landing = null;
  if (server.exit?.type === 'landing') landing = (state.landings || []).find((l) => l.id === server.exit.landingId) || null;
  if (landing) outbounds.push(landingOutbound(landing, 'exit'));
  const finalTag = landing ? 'exit' : 'direct';

  const rules = [{ action: 'sniff' }];
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
    // 统计在用设备时：连接日志写到文件，agent 每 15 秒读走并清空（只取来源 IP），警告和错误转到 agent 的日志里
    log: onlineTrackOn(state) ? { level: 'info', output: CONN_LOG, timestamp: false } : { level: 'warn', timestamp: true },
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
    log: { loglevel: 'warning', ...(onlineTrackOn(state) ? { access: XRAY_ACCESS_LOG } : {}) },
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

// 这台作为中转时要做的转发（给 agent）：节点协议目标只有一个；自定义目标可以填多个（主备 / 轮询）
function forwardTargets(f) {
  const t = f.target || {};
  const list = Array.isArray(t.targets) && t.targets.length ? t.targets : t.host && t.port ? [`${t.host}:${t.port}`] : [];
  return list.map((x) => String(x).trim()).filter(Boolean).map((x) => (/^\[|^[^:]+:\d+$/.test(x) ? x : x.includes(':') && /:\d+$/.test(x) ? `[${x.replace(/:(\d+)$/, '')}]:${x.match(/:(\d+)$/)[1]}` : x));
}
function agentForwards(state, server) {
  const out = [];
  for (const f of state.forwards || []) {
    if (f.relayServerId !== server.id || f.enabled === false) continue;
    const t = resolveForwardTarget(state, f);
    if (!t) continue;
    const targets = f.target?.type === 'node' ? [`${String(t.host).includes(':') ? `[${t.host}]` : t.host}:${t.port}`] : forwardTargets(f);
    if (!targets.length) continue;
    const net = t.network === 'both' ? '' : t.network || '';
    out.push({ id: f.id, name: f.name || '', listen: Number(f.listenPort), network: net, targets, strategy: f.strategy === 'roundrobin' ? 'roundrobin' : 'failover', allow: (f.allow || []).filter(Boolean) });
  }
  return out;
}

// ---------- 指纹、端口、隧道、跳跃端口（服务端配置和订阅都要用） ----------
// 客户端 TLS 指纹（Reality 用）。一键换新时会随机换一个
const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'edge'];
function fpOf(pc) { return FINGERPRINTS.includes(pc?.fp) ? pc.fp : 'chrome'; }
// TCP 协议的优先端口：443 最自然，其次是常见的 HTTPS 备用端口
const PREFERRED_TCP_PORTS = [443, 8443, 2053, 2083, 2087, 2096];
// 常用 Web 端口：不少服务商禁止在这几个端口上跑网站或做代理类 Web 伪装（违规会被停机）。默认一律避开，设置里可以关
const WEB_PORTS = [80, 443, 8080, 8443];
const avoidWebPorts = (state) => state?.settings?.avoidWebPorts !== false;
const isIpLiteral = (x) => /^(\d{1,3}\.){3}\d{1,3}$/.test(x) || (x.includes(':') && /^[0-9a-f:.]+$/i.test(x));
// Web 端口来源白名单：服务器上填的 IP / 网段，加上把这台当转发目标的中转机 IP（中转机要能连进来）
function webAllowOf(state, server) {
  const own = (server.webAllow || []).map((x) => String(x).trim()).filter(Boolean);
  if (!own.length) return [];
  const out = new Set(own);
  for (const f of state.forwards || []) {
    if (f.enabled === false || f.target?.type !== 'node' || f.target.serverId !== server.id) continue;
    const r = (state.servers || []).find((x) => x.id === f.relayServerId);
    for (const h of [r?.host, r?.host6]) { const v = String(h || '').trim().replace(/^\[|\]$/g, ''); if (v && isIpLiteral(v)) out.add(v); }
  }
  return [...out];
}
// 这个端口能不能用：没开「避开常用 Web 端口」、不是 Web 端口，或者这台服务器设了来源白名单（服务商允许只对指定 IP 开放）
const allowedPort = (state, port, server) => !avoidWebPorts(state) || !WEB_PORTS.includes(Number(port)) || !!(server && webAllowOf(state, server).length);
// 这台服务器上违反「避开常用 Web 端口」的地方：落在 Web 端口又没设白名单的协议，以及要用 TCP 80 做验证的正式证书（没开避开时返回空）
function webPortUses(state, server) {
  if (!avoidWebPorts(state)) return [];
  const out = [];
  const listed = webAllowOf(state, server).length > 0;
  for (const [k, m] of Object.entries(PROTOCOLS)) {
    const pc = server.protocols?.[k];
    if (!pc?.enabled || (k === 'vmess' && cfTunnelOf(server)) || listed) continue;
    if (WEB_PORTS.includes(Number(pc.port))) out.push({ key: k, label: m.label, port: Number(pc.port), net: m.net });
  }
  if (usesAcme(server)) out.push({ key: 'acme', label: '正式证书（Let\'s Encrypt 用 TCP 80 验证）', port: 80, net: 'tcp' });
  return out;
}
// 给 agent 的端口来源白名单：设了白名单的服务器上落在 Web 端口的协议，以及填了来源白名单的端口转发（在防火墙层面拦，扫端口也看不到）
function portAllowRules(state, server) {
  const out = [];
  const allow = webAllowOf(state, server);
  if (allow.length) {
    for (const [k, m] of Object.entries(PROTOCOLS)) {
      const pc = server.protocols?.[k];
      if (!pc?.enabled || (k === 'vmess' && cfTunnelOf(server)) || !WEB_PORTS.includes(Number(pc.port))) continue;
      out.push({ port: Number(pc.port), net: m.net, allow });
    }
  }
  for (const f of state.forwards || []) {
    if (f.relayServerId !== server.id || f.enabled === false || !(f.allow || []).length) continue;
    out.push({ port: Number(f.listenPort), net: resolveForwardTarget(state, f)?.network || 'both', allow: f.allow });
  }
  return out;
}
// Hysteria2 端口跳跃范围，如 "20000-30000"；经中转的入口不跳跃
function hopRange(server, entry) {
  const r = String(server.protocols?.hysteria2?.hopPorts || '').trim();
  const m = r.match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!m || entry.via) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a > 0 && b > a && b <= 65535 ? [a, b] : null;
}
// ---------- 节点入口（直连 + 经中转） ----------
// Cloudflare 隧道配置（需要启用 VMess-WS、填了令牌和域名才算生效）
function cfTunnelOf(server) {
  const t = server.cfTunnel;
  if (!t?.enabled || !t.token || !t.hostname || !server.protocols?.vmess?.enabled) return null;
  return { token: t.token.trim(), hostname: t.hostname.trim(), cdnHosts: (t.cdnHosts || []).map((x) => String(x).trim()).filter(Boolean) };
}
// 订阅走 HTTPS（不用域名）：设置里没关、也没填订阅域名时，agent 给 VPS 的 IP 申请 Let's Encrypt 证书
// 订阅的 IP 证书要用 TCP 80 做 http-01 验证：开了「避开常用 Web 端口」时不申请（订阅走 HTTP，或用 Cloudflare 代理的订阅域名走 HTTPS）
function subTlsWanted(state) { return state.settings?.subHttps !== false && !state.settings?.subDomain && !avoidWebPorts(state); }

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

// 部署时「自动优选端口」：伪装成 HTTPS 的协议优先用 HTTPS 常用端口，Hysteria2 优先 UDP 443（像 HTTP/3）；开了「避开常用 Web 端口」（默认）时跳过 80 / 443 / 8080 / 8443，
// Reality / XHTTP 落到 2053、2083 这类 Cloudflare 的 HTTPS 备用端口，
// 其它协议用随机高位端口（避开 8388 这类一看就是代理的默认端口）。busy = VPS 上被其它程序占用的 { tcp: [], udp: [] }
const AUTO_PREFER = {
  vlessReality: [443, 8443, 2053, 2083, 2087, 2096],
  vlessXhttpReality: [443, 8443, 2053, 2083, 2087, 2096],
  vlessXhttpTls: [443, 8443, 2053, 2083, 2087, 2096],
  hysteria2: [443, 8443],
};
// 给一个协议挑优选端口：先按 AUTO_PREFER 顺序挑，都不行就随机高位端口。
// 避开本服务器其它协议 / 端口跳跃范围 / 转发 / 订阅端口、SSH 端口、busy（VPS 上被别的程序占用的 { tcp, udp }）和 avoid
function preferredFreePort(state, server, protocolKey, { busy = {}, avoid = [] } = {}) {
  const nets = netsOf(PROTOCOLS[protocolKey].net);
  const used = new Set();
  const ranges = [];
  for (const { port, net: n, range, key } of serverPorts(state, server)) {
    if (range) { ranges.push(range); continue; }
    if (key === protocolKey) continue;
    if (port) for (const x of netsOf(n)) used.add(`${x}/${port}`);
  }
  for (const x of busy.tcp || []) used.add(`tcp/${x}`);
  for (const x of busy.udp || []) used.add(`udp/${x}`);
  for (const x of avoid) for (const n of nets) used.add(`${n}/${x}`);
  used.add(`tcp/${Number(server.sshPort) || 22}`);
  const ok = (port) => allowedPort(state, port) && nets.every((x) => !used.has(`${x}/${port}`)) && !ranges.some(([a, b]) => port >= a && port <= b);
  let port = (AUTO_PREFER[protocolKey] || []).find(ok);
  for (let i = 0; !port && i < 500; i++) { const c = 10000 + crypto.randomInt(50000); if (ok(c)) port = c; }
  if (!port) throw new Error('找不到空闲端口');
  return port;
}

function autoPickPorts(state, server, busy = {}) {
  const p = server.protocols || {};
  const keys = Object.keys(PROTOCOLS).filter((k) => p[k]?.enabled && !(k === 'vmess' && cfTunnelOf(server)));
  for (const k of keys) p[k].port = 0; // 先全部腾空，按顺序重新挑
  const picked = [];
  for (const k of keys) {
    p[k].port = preferredFreePort(state, server, k, { busy });
    picked.push(`${PROTOCOLS[k].label} ${p[k].port}`);
  }
  return picked;
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
  return PREFERRED_TCP_PORTS.find((port) => allowedPort(state, port) && !netsOf(net).some((x) => used.has(`${x}/${port}`)) && !ranges.some(([a, b]) => port >= a && port <= b)) || 0;
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

module.exports = { autoPickPorts, preferredFreePort, WEB_PORTS, avoidWebPorts, allowedPort, webPortUses, webAllowOf, portAllowRules,
  subTlsWanted, cfTunnelOf, fpOf, FINGERPRINTS, PREFERRED_TCP_PORTS, hopRange, PROTOCOLS, REMOTE_DIR, agentForwards, forwardTargets, CONN_LOG, XRAY_ACCESS_LOG, onlineTrackOn, GB, randId, randHex, randPassword, uuid, realityKeypair, defaultProtocols, newServer, newUser, userStatus, userExpireAt, userUsedBytes, userHasServer, usersForServer, buildServerConfig, XRAY_KEYS, isXray, usesXray, realityOn, xrayPorts, buildXrayConfig, acmeCertFiles, xhttpPath, netsOf, serverPorts, checkPortConflicts, resolveForwardTarget, landingOutbound, pickFreePort, rotateServer, ensureProtocols, ssUserKey, pickPreferredPort, usesAcme, tlsSniFor, WARP_SITES,
  // 内部共用（订阅模块要用）
  SS_METHOD,
};

// 节点入口、分享链接、订阅（v2rayN / Clash / sing-box）、客户端出站在 subscribe.js；
// 这里合并导出，外面照旧用 core.xxx。放在最后，subscribe.js 加载时 core 已经导出完了
Object.assign(module.exports, require('./subscribe'));
