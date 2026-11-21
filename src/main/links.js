'use strict';
// 解析分享链接 → sing-box 出站（用于「落地」支持机场节点）
// 支持：vless / vmess / trojan / ss / hysteria2(hy2) / tuic / anytls / socks / http

function b64decode(s) {
  const t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64').toString('utf8');
}

function looksBase64(s) { return /^[A-Za-z0-9+/=_-]+$/.test(String(s).trim()); }

function splitHostPort(hp) {
  const m = hp.match(/^\[([^\]]+)\]:(\d+)$/) || hp.match(/^([^:]+):(\d+)$/);
  if (!m) throw new Error('地址格式不对：' + hp);
  return { host: m[1], port: Number(m[2]) };
}

// 通用 URL 拆分（不依赖 WHATWG URL 对非标准协议的处理差异）
function parseUrlLike(link) {
  const m = link.match(/^([a-z0-9+]+):\/\/([^#]*?)(?:#(.*))?$/i);
  if (!m) throw new Error('不是分享链接');
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  const name = m[3] ? safeDecode(m[3]) : '';
  let query = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  rest = rest.replace(/\/$/, '');
  let auth = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) { auth = rest.slice(0, at); rest = rest.slice(at + 1); }
  const params = Object.fromEntries(new URLSearchParams(query));
  return { scheme, auth: safeDecode(auth), hostport: rest, params, name };
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

function tlsFrom(p, host, { reality = false, defaultOn = false } = {}) {
  const sec = (p.security || '').toLowerCase();
  if (!reality && sec !== 'tls' && sec !== 'xtls' && !defaultOn) return undefined;
  const tls = { enabled: true, server_name: p.sni || p.peer || p.host || host };
  if (p.allowInsecure === '1' || p.insecure === '1' || p.allow_insecure === '1' || p.skipCertVerify === 'true') tls.insecure = true;
  if (p.alpn) tls.alpn = p.alpn.split(',').filter(Boolean);
  if (p.fp) tls.utls = { enabled: true, fingerprint: p.fp };
  if (reality) {
    tls.reality = { enabled: true, public_key: p.pbk, short_id: p.sid || '' };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
  }
  return tls;
}

function transportFrom(p) {
  const type = (p.type || p.net || 'tcp').toLowerCase();
  if (type === 'ws') {
    const t = { type: 'ws', path: p.path || '/' };
    if (p.host) t.headers = { Host: p.host };
    return t;
  }
  if (type === 'grpc') return { type: 'grpc', service_name: p.serviceName || p.path || '' };
  if (type === 'http' || type === 'h2') return { type: 'http', host: p.host ? [p.host] : undefined, path: p.path || '/' };
  if (type === 'httpupgrade') return { type: 'httpupgrade', path: p.path || '/', host: p.host || undefined };
  if (type === 'tcp' || type === 'raw' || type === '') return undefined;
  throw new Error(`sing-box 不支持 ${type} 传输（如 xhttp）`);
}

function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

// 返回 { name, outbound }
function parseShareLink(raw, tag = 'proxy') {
  const link = String(raw).trim();
  if (!link) throw new Error('空链接');
  if (/^vmess:\/\//i.test(link)) {
    const body = link.slice(8).split('#')[0];
    if (!looksBase64(body)) throw new Error('vmess 链接格式不支持');
    const j = JSON.parse(b64decode(body));
    const p = { ...j, type: j.net, security: j.tls === 'tls' ? 'tls' : '', sni: j.sni, host: j.host, path: j.path, alpn: j.alpn, fp: j.fp };
    const out = clean({
      type: 'vmess', tag, server: j.add, server_port: Number(j.port), uuid: j.id, alter_id: Number(j.aid || 0), security: j.scy || 'auto',
      tls: tlsFrom(p, j.add), transport: transportFrom(p),
    });
    return { name: j.ps || `${j.add}:${j.port}`, outbound: out };
  }
  const u = parseUrlLike(link);
  const name = u.name;
  const p = u.params;
  switch (u.scheme) {
    case 'vless': {
      const { host, port } = splitHostPort(u.hostport);
      const reality = (p.security || '').toLowerCase() === 'reality';
      const out = clean({ type: 'vless', tag, server: host, server_port: port, uuid: u.auth, flow: p.flow || undefined, tls: tlsFrom(p, host, { reality }), transport: transportFrom(p), packet_encoding: 'xudp' });
      return { name: name || `${host}:${port}`, outbound: out };
    }
    case 'trojan': {
      const { host, port } = splitHostPort(u.hostport);
      const out = clean({ type: 'trojan', tag, server: host, server_port: port, password: u.auth, tls: tlsFrom(p, host, { defaultOn: (p.security || 'tls') !== 'none' }), transport: transportFrom(p) });
      return { name: name || `${host}:${port}`, outbound: out };
    }
    case 'ss': {
      let method; let password; let hp = u.hostport;
      if (u.auth) {
        const a = u.auth.includes(':') ? u.auth : b64decode(u.auth);
        const i = a.indexOf(':');
        method = a.slice(0, i); password = a.slice(i + 1);
      } else {
        // 旧格式：ss://base64(method:password@host:port)
        const d = b64decode(hp);
        const at = d.lastIndexOf('@');
        const a = d.slice(0, at); hp = d.slice(at + 1);
        const i = a.indexOf(':');
        method = a.slice(0, i); password = a.slice(i + 1);
      }
      const { host, port } = splitHostPort(hp);
      if (p.plugin) throw new Error('暂不支持带插件的 SS 链接');
      return { name: name || `${host}:${port}`, outbound: { type: 'shadowsocks', tag, server: host, server_port: port, method, password } };
    }
    case 'hysteria2':
    case 'hy2': {
      const { host, port } = splitHostPort(u.hostport);
      const out = clean({ type: 'hysteria2', tag, server: host, server_port: port, password: u.auth, tls: tlsFrom(p, host, { defaultOn: true }) });
      if (p.obfs === 'salamander' && p['obfs-password']) out.obfs = { type: 'salamander', password: p['obfs-password'] };
      if (p.mport) { out.server_ports = p.mport.split(',').map((r) => r.replace('-', ':')); out.hop_interval = '30s'; }
      if (!out.tls.alpn) out.tls.alpn = ['h3'];
      return { name: name || `${host}:${port}`, outbound: out };
    }
    case 'tuic': {
      const { host, port } = splitHostPort(u.hostport);
      const i = u.auth.indexOf(':');
      const out = clean({ type: 'tuic', tag, server: host, server_port: port, uuid: u.auth.slice(0, i), password: u.auth.slice(i + 1), congestion_control: p.congestion_control || 'bbr', udp_relay_mode: p.udp_relay_mode || undefined, tls: tlsFrom(p, host, { defaultOn: true }) });
      if (!out.tls.alpn) out.tls.alpn = ['h3'];
      return { name: name || `${host}:${port}`, outbound: out };
    }
    case 'anytls': {
      const { host, port } = splitHostPort(u.hostport);
      return { name: name || `${host}:${port}`, outbound: clean({ type: 'anytls', tag, server: host, server_port: port, password: u.auth, tls: tlsFrom(p, host, { defaultOn: true }) }) };
    }
    case 'socks':
    case 'socks5':
    case 'http':
    case 'https': {
      const { host, port } = splitHostPort(u.hostport);
      let a = u.auth;
      if (a && !a.includes(':') && looksBase64(a)) a = b64decode(a);
      const i = a.indexOf(':');
      const out = clean({ type: u.scheme.startsWith('socks') ? 'socks' : 'http', tag, server: host, server_port: port, username: a ? a.slice(0, i >= 0 ? i : undefined) : undefined, password: i >= 0 ? a.slice(i + 1) : undefined });
      if (out.type === 'socks') out.version = '5';
      if (u.scheme === 'https') out.tls = { enabled: true, server_name: host };
      return { name: name || `${host}:${port}`, outbound: out };
    }
    default:
      throw new Error('不支持的链接类型：' + u.scheme);
  }
}

// 订阅内容（base64 或明文多行）→ 链接数组
function splitSubscription(text) {
  let t = String(text || '').trim();
  if (!t.includes('://') && looksBase64(t.replace(/\s+/g, ''))) t = b64decode(t.replace(/\s+/g, ''));
  return t.split(/\r?\n/).map((x) => x.trim()).filter((x) => /^[a-z0-9+]+:\/\//i.test(x));
}

module.exports = { parseShareLink, splitSubscription, b64decode };
