'use strict';
// 节点入口（直连 + 经中转 + CF 隧道）、分享链接、订阅（v2rayN base64 / Clash Meta / sing-box）、本地测试用客户端出站。
// 由 core.js 合并导出，外面照旧用 core.xxx。
const core = require('./core');
const { GB, PROTOCOLS, SS_METHOD, cfTunnelOf, fpOf, hopRange, ssUserKey, subTlsWanted, tlsSniFor, userExpireAt, userHasServer, userUsedBytes, usersForServer, usesAcme, xhttpPath } = core;

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
      out.push({ serverId: server.id, protocol: key, host, port: Number(p[key].port), label: p[key].name ? `${p[key].name}${suffix}` : `${server.name}-${PROTOCOLS[key].label}${suffix}`, custom: !!p[key].name });
    }
  }
  for (const f of state.forwards || []) {
    if (f.enabled === false || f.target?.type !== 'node' || f.target.serverId !== server.id) continue;
    if (!p[f.target.protocol]?.enabled) continue;
    const relay = (state.servers || []).find((x) => x.id === f.relayServerId);
    if (!relay) continue;
    out.push({
      serverId: server.id, protocol: f.target.protocol, host: relay.host, port: Number(f.listenPort),
      label: f.nodeName || `${server.name}-${PROTOCOLS[f.target.protocol].label}-经${relay.name}`, via: relay.id,
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


// Reality 目标备选：找不到同网段邻居时，从这些大站里挑 VPS 连得最快的。
// 不放 Google 系（国内按 SNI 阻断）和 Cloudflare（CDN，不像真实站点）
// 在国内按域名（SNI）屏蔽的网站，不能当 Reality 目标 / 自签证书域名（和 agent/reality.go 的 blockedSNI 一致）
const SNI_BLOCKED = ['google.com', 'googleapis.com', 'gstatic.com', 'googlevideo.com', 'youtube.com', 'ytimg.com', 'facebook.com', 'fbcdn.net', 'instagram.com', 'whatsapp.com', 'whatsapp.net', 'twitter.com', 'x.com', 'twimg.com', 'telegram.org', 't.me', 'wikipedia.org', 'wikimedia.org', 'netflix.com', 'reddit.com', 'discord.com', 'discord.gg', 'pinterest.com', 'dropbox.com', 'openai.com', 'chatgpt.com', 'blogspot.com', 'nytimes.com', 'medium.com', 'github.io', 'pornhub.com', 'xvideos.com', 'onlyfans.com', 'bbc.com', 'voanews.com', 'rfa.org', 'theepochtimes.com', 'ntdtv.com'];
function sniBlocked(d) {
  d = String(d || '').toLowerCase().replace(/\.$/, '');
  return SNI_BLOCKED.some((b) => d === b || d.endsWith('.' + b));
}

const REALITY_FALLBACKS = ['www.microsoft.com', 'www.apple.com', 'www.amazon.com', 'www.nvidia.com', 'www.samsung.com', 'www.tesla.com', 'www.oracle.com', 'www.cisco.com', 'addons.mozilla.org'];



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
    // XHTTP-Reality 不进 Clash 订阅：Xray 26.11 的 Reality 服务端只认带 X25519MLKEM768（抗量子）密钥交换的握手，
    // mihomo 1.19.34 的 Reality 握手还没有，连不上（REALITY authentication failed；端到端测试里实测）
    case 'vlessXhttpReality':
      return null;
    // mihomo 1.19.22 起支持 XHTTP；更老的 Clash 内核由 agent 按 UA 去掉这个节点
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

module.exports = { hostForUri, subBase, homeServerId, subscriptionUrls, buildSingboxClient, uniqueEntries, nodeEntries, shareLink, clashProxy, clientOutbound, clientTestConfig, userEntries, buildSubscription, buildAgentUsers, buildAgentSubs, subscriptionUrl, xrayClientOutbound, xrayTestConfig, SNI_BLOCKED, sniBlocked, subCertOk, buildTunnelConfig, certPinOf, REALITY_FALLBACKS, serverHosts };
