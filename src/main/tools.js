'use strict';
// 免登录工具箱
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

async function ipInfo(fetchFn, ip) {
  const q = (ip || '').trim();
  const fields = 'status,message,query,country,countryCode,regionName,city,isp,org,as,asname,mobile,proxy,hosting,timezone';
  const r = await fetchFn(`http://ip-api.com/json/${encodeURIComponent(q)}?fields=${fields}&lang=zh-CN`);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.message || '查询失败');
  let kind = '住宅/普通宽带';
  if (j.hosting) kind = '机房 IP（数据中心）';
  else if (j.mobile) kind = '移动网络';
  if (j.proxy) kind += '，已被标记为代理/VPN';
  return { ...j, kind };
}

function tcpPing(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port: Number(port) });
    const done = (ok, err) => { sock.destroy(); resolve({ port: Number(port), ok, ms: ok ? Date.now() - t0 : null, error: err || '' }); };
    sock.setTimeout(timeout, () => done(false, '超时'));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

async function portCheck(host, portsText) {
  const ports = [];
  for (const part of String(portsText).split(/[,，\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) { for (let p = +m[1]; p <= +m[2] && ports.length < 200; p++) ports.push(p); } else if (/^\d+$/.test(part)) ports.push(+part);
  }
  if (!ports.length) throw new Error('请输入端口，例如 443,8443 或 2000-2010');
  const results = [];
  for (let i = 0; i < ports.length; i += 20) {
    results.push(...(await Promise.all(ports.slice(i, i + 20).map((p) => tcpPing(host.trim(), p)))));
  }
  return results;
}

async function dnsLookup(name, type = 'A', server = '') {
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  if (server) resolver.setServers([server]);
  const t0 = Date.now();
  let records;
  switch (type) {
    case 'A': records = await resolver.resolve4(name.trim(), { ttl: true }); break;
    case 'AAAA': records = await resolver.resolve6(name.trim(), { ttl: true }); break;
    default: records = await resolver.resolve(name.trim(), type);
  }
  return { ms: Date.now() - t0, records };
}

function traceroute(host, onLine) {
  return new Promise((resolve, reject) => {
    const h = host.trim();
    if (!/^[a-zA-Z0-9.:-]+$/.test(h)) return reject(new Error('地址格式不正确'));
    const isWin = process.platform === 'win32';
    const p = isWin ? spawn('tracert', ['-d', '-w', '1500', '-h', '30', h]) : spawn('traceroute', ['-n', '-w', '2', '-m', '30', h]);
    const decoder = isWin ? new TextDecoder('gbk') : new TextDecoder('utf-8');
    let buf = '';
    const feed = (d) => {
      buf += decoder.decode(d, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) onLine(l);
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => reject(new Error('无法运行路由追踪：' + e.message)));
    p.on('close', () => { if (buf.trim()) onLine(buf); resolve(true); });
  });
}

// 检测某个域名是否适合当 Reality 目标：TLS1.3 + H2 + X25519
function realityCheck(domain, timeout = 8000) {
  return new Promise((resolve) => {
    const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const t0 = Date.now();
    const sock = tls.connect({ host: d, port: 443, servername: d, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false });
    const finish = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeout, () => finish({ domain: d, ok: false, error: '连接超时' }));
    sock.once('error', (e) => finish({ domain: d, ok: false, error: e.code || e.message }));
    sock.once('secureConnect', () => {
      const ms = Date.now() - t0;
      const proto = sock.getProtocol();
      const alpn = sock.alpnProtocol || '';
      const key = sock.getEphemeralKeyInfo() || {};
      const cert = sock.getPeerCertificate() || {};
      const checks = [
        { name: 'TLS 1.3', ok: proto === 'TLSv1.3', value: proto },
        { name: 'HTTP/2 (ALPN h2)', ok: alpn === 'h2', value: alpn || '无' },
        { name: 'X25519 密钥交换', ok: /x25519/i.test(key.name || ''), value: key.name || key.type || '未知' },
        { name: '证书有效', ok: sock.authorized, value: sock.authorized ? (cert.issuer?.O || cert.issuer?.CN || '有效') : String(sock.authorizationError || '无效') },
      ];
      finish({ domain: d, ok: checks.every((c) => c.ok), ms, checks, subject: cert.subject?.CN || '', validTo: cert.valid_to || '' });
    });
  });
}

// 解析各种格式的 SOCKS5：host:port:user:pass / user:pass@host:port / socks5://user:pass@host:port
function parseSocks(text) {
  let s = text.trim();
  let name = '';
  const hash = s.indexOf('#');
  if (hash >= 0) { name = decodeURIComponent(s.slice(hash + 1)); s = s.slice(0, hash); }
  s = s.replace(/^socks5?h?:\/\//i, '');
  let host, port, user = '', pass = '';
  if (s.includes('@')) {
    const [auth, hp] = [s.slice(0, s.lastIndexOf('@')), s.slice(s.lastIndexOf('@') + 1)];
    let a = auth;
    if (!a.includes(':')) { try { a = Buffer.from(a, 'base64').toString(); } catch (_) { /* ignore */ } }
    [user, pass] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)];
    const i = hp.lastIndexOf(':');
    host = hp.slice(0, i).replace(/^\[|\]$/g, ''); port = hp.slice(i + 1);
  } else {
    const parts = s.split(':');
    if (parts.length >= 4) { [host, port, user] = parts; pass = parts.slice(3).join(':'); } else { [host, port] = parts; }
  }
  if (!host || !/^\d+$/.test(String(port))) throw new Error('无法识别格式，支持 ip:端口:用户:密码 或 用户:密码@ip:端口');
  return { host, port: Number(port), user: decodeURIComponent(user || ''), pass: decodeURIComponent(pass || ''), name: name || `${host}:${port}` };
}

async function socksToQr(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines.slice(0, 50)) {
    try {
      const p = parseSocks(l);
      const h = p.host.includes(':') ? `[${p.host}]` : p.host;
      const auth = p.user ? Buffer.from(`${p.user}:${p.pass}`).toString('base64') + '@' : '';
      const link = `socks://${auth}${h}:${p.port}#${encodeURIComponent(p.name)}`;
      const plain = `socks5://${p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@` : ''}${h}:${p.port}`;
      out.push({ ok: true, ...p, link, plain, qr: await QRCode.toDataURL(link, { margin: 1, width: 220 }) });
    } catch (e) { out.push({ ok: false, input: l, error: e.message }); }
  }
  return out;
}

function qr(text) { return QRCode.toDataURL(text, { margin: 1, width: 260 }); }

module.exports = { ipInfo, portCheck, tcpPing, dnsLookup, traceroute, realityCheck, parseSocks, socksToQr, qr };
