'use strict';
// 经本机代理（V2rayN / Clash 等）建立 TCP 隧道：SOCKS5 或 HTTP CONNECT
const net = require('net');

function readUntil(sock, predicate, timeout) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('代理握手超时')), timeout);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const n = predicate(buf);
      if (n > 0) done(null, buf.slice(0, n), buf.slice(n));
    };
    const onErr = (e) => done(e);
    const onClose = () => done(new Error('代理关闭了连接'));
    function done(err, head, rest) {
      clearTimeout(timer);
      sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose);
      if (err) reject(err);
      else { if (rest && rest.length) sock.unshift(rest); resolve(head); }
    }
    sock.on('data', onData); sock.once('error', onErr); sock.once('close', onClose);
  });
}

function connectTcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error('连接代理超时')); }, timeout);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function socks5(proxy, host, port, timeout) {
  const s = await connectTcp(proxy.host, proxy.port, timeout);
  try {
    s.write(Buffer.from([5, 1, 0]));
    const g = await readUntil(s, (b) => (b.length >= 2 ? 2 : 0), timeout);
    if (g[0] !== 5 || g[1] !== 0) throw new Error('SOCKS5 代理需要认证或不兼容');
    let addr;
    if (net.isIPv4(host)) addr = Buffer.from([1, ...host.split('.').map(Number)]);
    else if (net.isIPv6(host)) {
      const full = host.includes('::') ? expandV6(host) : host;
      addr = Buffer.concat([Buffer.from([4]), Buffer.from(full.split(':').map((x) => x.padStart(4, '0')).join(''), 'hex')]);
    } else addr = Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
    s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([port >> 8, port & 255])]));
    const r = await readUntil(s, (b) => {
      if (b.length < 5) return 0;
      const len = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : 0;
      return b.length >= 4 + len + 2 ? 4 + len + 2 : 0;
    }, timeout);
    if (r[1] !== 0) throw new Error('SOCKS5 代理连接目标失败（代码 ' + r[1] + '）');
    return s;
  } catch (e) { s.destroy(); throw e; }
}

function expandV6(h) {
  const [a, b] = h.split('::');
  const left = a ? a.split(':') : [];
  const right = b ? b.split(':') : [];
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].join(':');
}

async function httpConnect(proxy, host, port, timeout) {
  const s = await connectTcp(proxy.host, proxy.port, timeout);
  try {
    const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const head = await readUntil(s, (b) => { const i = b.indexOf('\r\n\r\n'); return i >= 0 ? i + 4 : 0; }, timeout);
    const line = head.toString().split('\r\n')[0];
    if (!/^HTTP\/1\.[01] 200/.test(line)) throw new Error('HTTP 代理拒绝：' + line);
    return s;
  } catch (e) { s.destroy(); throw e; }
}

// proxy: { type: 'socks5' | 'http', host, port }
function openTunnel(proxy, host, port, timeout = 15000) {
  return proxy.type === 'http' ? httpConnect(proxy, host, Number(port), timeout) : socks5(proxy, host, Number(port), timeout);
}

function parseProxyUrl(s) {
  const m = String(s || '').trim().match(/^(socks5?h?|http):\/\/\[?([^\]\s/]+?)\]?:(\d+)\/?$/i);
  if (!m) return null;
  return { type: m[1].toLowerCase().startsWith('http') ? 'http' : 'socks5', host: m[2], port: Number(m[3]) };
}

// 解析 Electron resolveProxy 的结果，如 "PROXY 127.0.0.1:10809; SOCKS5 127.0.0.1:10808; DIRECT"
function parsePac(str) {
  const out = [];
  for (const part of String(str || '').split(';')) {
    const m = part.trim().match(/^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+\[?([^\]\s]+?)\]?:(\d+)$/i);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    if (kind === 'SOCKS4') continue;
    out.push({ type: kind.startsWith('SOCKS') ? 'socks5' : 'http', host: m[2], port: Number(m[3]) });
  }
  return out;
}

// 常见客户端的本地端口：V2rayN 10808(socks)/10809(http)，Clash 7890/7891，Clash Verge 7897
const COMMON = [
  { type: 'socks5', host: '127.0.0.1', port: 10808 },
  { type: 'http', host: '127.0.0.1', port: 10809 },
  { type: 'socks5', host: '127.0.0.1', port: 7890 },
  { type: 'socks5', host: '127.0.0.1', port: 7897 },
  { type: 'socks5', host: '127.0.0.1', port: 7891 },
];

function portOpen(host, port, timeout = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function localCandidates(pacStr) {
  const seen = new Set();
  const list = [];
  for (const p of [...parsePac(pacStr), ...COMMON]) {
    const k = `${p.type}:${p.host}:${p.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (await portOpen(p.host, p.port)) list.push(p);
  }
  return list;
}

function proxyLabel(p) { return `${p.type}://${p.host}:${p.port}`; }

module.exports = { openTunnel, parseProxyUrl, parsePac, localCandidates, proxyLabel };
