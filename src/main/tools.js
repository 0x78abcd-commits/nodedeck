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
// Reality 目标检测（本机）。和 VPS 上 agent 的 check-reality 同一套标准、同样的四项：
// TLS 1.3、HTTP/2、X25519、证书有效。先不加限制握手读取对方支持什么，再只允许 TLS 1.3 + X25519 握手确认密钥交换。
function tlsHandshake(d, opts, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sock;
    try {
      sock = tls.connect({ host: d, port: opts.port || 443, servername: d, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false, ...opts });
    } catch (e) { resolve({ error: e.message }); return; }
    const finish = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(timeout, () => finish({ error: '连接超时' }));
    sock.once('error', (e) => finish({ error: e.code || e.message }));
    sock.once('secureConnect', () => finish({ ms: Date.now() - t0, proto: sock.getProtocol(), alpn: sock.alpnProtocol || '', authorized: sock.authorized, authError: sock.authorizationError, cert: sock.getPeerCertificate() || {} }));
  });
}

async function realityCheck(domain, timeout = 8000, port = 443) {
  const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const at = Date.now();
  const a = await tlsHandshake(d, { port, minVersion: 'TLSv1.2' }, timeout);
  if (a.error) return { domain: d, ok: false, where: 'local', at, error: '连接失败：' + a.error };
  const x = { name: 'X25519', ok: false, value: '需要先支持 TLS 1.3' };
  let ms = a.ms;
  if (a.proto === 'TLSv1.3') {
    const b = await tlsHandshake(d, { port, minVersion: 'TLSv1.3', ecdhCurve: 'X25519' }, timeout);
    if (b.error) x.value = '不支持（' + b.error + '）';
    else { x.ok = true; x.value = '支持'; ms = b.ms; }
  }
  const validTo = a.cert.valid_to ? new Date(a.cert.valid_to).toISOString().slice(0, 10) : '';
  const checks = [
    { name: 'TLS 1.3', ok: a.proto === 'TLSv1.3', value: (a.proto || '未知').replace('TLSv', 'TLS ') },
    { name: 'HTTP/2', ok: a.alpn === 'h2', value: a.alpn || '无' },
    x,
    { name: '证书有效', ok: !!a.authorized, value: a.authorized ? `${a.cert.issuer?.O || a.cert.issuer?.CN || ''}，到期 ${validTo}` : String(a.authError || '无效') },
  ];
  const bad = checks.filter((c) => !c.ok).map((c) => c.name);
  return { domain: d, ok: !bad.length, ms, checks, where: 'local', at, subject: a.cert.subject?.CN || '', validTo, error: bad.length ? '不满足：' + bad.join('、') : '' };
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
      out.push({ ok: true, ...p, link, plain, qr: await qr(link) });
    } catch (e) { out.push({ ok: false, input: l, error: e.message }); }
  }
  return out;
}

// 二维码：矢量 SVG（任何缩放下边缘都清晰）、标准的 4 格白边、低纠错（点更大更好扫，屏幕上扫不会有污损）。
// 以前是 1 格白边的位图，被系统缩放模糊后，链接长的（如 VLESS-Reality）手机常常扫不出来
async function qr(text) {
  const svg = await QRCode.toString(String(text), { type: 'svg', margin: 4, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

module.exports = { ipInfo, portCheck, tcpPing, dnsLookup, traceroute, realityCheck, parseSocks, socksToQr, qr };
