'use strict';
// 访问自己 VPS 上 agent 的 HTTPS 接口（测速、查出口 IP、被墙互查）：
// 证书是 Let's Encrypt 的就按正常方式校验；是 agent 自己生成的自签证书，就认 agent 报来的那张（部署 / 同步时读到的），
// 校验在 TLS 握手里完成，口令在证书对上之前不会发出去。老版本 agent 还没报证书时，先不校验证书（照样加密）。
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const derOfPem = (pem) => Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const fp = (der) => crypto.createHash('sha256').update(der).digest('hex');

function tlsOptions(server) {
  const pem = server?.lastStatus?.subSelfPem;
  if (!pem) return { rejectUnauthorized: false };
  const selfFp = fp(derOfPem(pem));
  return {
    ca: [...tls.rootCertificates, pem],
    checkServerIdentity: (host, cert) => (cert?.raw && fp(cert.raw) === selfFp ? undefined : tls.checkServerIdentity(host, cert)),
  };
}

// 和 http.request 一样的参数，多一个 server（用来取证书）
function request(server, opts, cb) {
  return https.request({ ...opts, ...tlsOptions(server) }, cb);
}

// 发 GET 读 JSON
function getJSON(server, url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(server, { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 443), path: u.pathname + u.search, method: 'GET', agent: false, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(new Error('返回太大')); });
      res.on('end', () => {
        if (res.statusCode === 404) { reject(Object.assign(new Error('agent 太旧，同步后可用'), { status: 404 })); return; }
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error(`HTTP ${res.statusCode}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

// 节点测试用的 Electron 会话：证书校验不过时，如果是我们某台 VPS 的自签证书也放行
function isOurSelfCert(state, pemData) {
  const want = fp(derOfPem(pemData));
  return (state.servers || []).some((s) => s.lastStatus?.subSelfPem && fp(derOfPem(s.lastStatus.subSelfPem)) === want);
}

module.exports = { tlsOptions, request, getJSON, isOurSelfCert };
