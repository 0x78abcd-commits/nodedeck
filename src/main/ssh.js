'use strict';
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');
const { openTunnel, proxyLabel } = require('./proxy');

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// 由主进程注入：返回可用的本机代理列表（[{type,host,port}]），没有则返回 []
let proxyProvider = async () => [];
function setProxyProvider(fn) { proxyProvider = fn; }

// 主机指纹：第一次连上时记下来（由主进程注入保存方法），以后每次核对，变了就拒绝连接（防中间人截获密码）
let hostKeySaver = () => {};
function setHostKeySaver(fn) { hostKeySaver = fn; }
function fingerprint(key) { return 'SHA256:' + require('crypto').createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); }
function mismatchError(server, got) {
  const e = new Error(`服务器 ${server.host} 的 SSH 主机指纹和第一次连接时不一样，已拒绝连接，密码没有发出去。\n上次：${server.hostKey}\n这次：${got}\n如果你刚重装过系统或换了 IP 上的机器，这是正常的：在「编辑」里点「重置指纹」后再连。否则可能有人在中间劫持连接，先别继续。`);
  e.hostKeyMismatch = true;
  return e;
}

// 记住哪些服务器上次是经代理连上的，下次先走代理
const preferProxy = new Map();

function isAuthError(e) {
  return /authentication methods failed|Cannot parse privateKey|passphrase|Encrypted private key|bad decrypt/i.test(String(e && e.message));
}

function friendlyError(e, server) {
  const m = String(e && e.message ? e.message : e);
  const where = `${server.host}:${server.sshPort || 22}`;
  if (/authentication methods failed/i.test(m)) return `SSH 登录失败：用户名、密码或私钥不对（这里要填 VPS 的 SSH 账号，root 居多）`;
  if (/passphrase|Encrypted private key|bad decrypt/i.test(m)) return '私钥带密码短语，请在「私钥密码」里填写（或填写有误）';
  if (/Cannot parse privateKey|Unsupported key format/i.test(m)) return '私钥格式不对：请粘贴完整的私钥内容（-----BEGIN … PRIVATE KEY----- 开头）';
  if (/ECONNREFUSED/.test(m)) return `${where} 拒绝连接：SSH 端口填错，或服务器上 SSH 服务没开`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `找不到 ${server.host}：IP 或域名填错了`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return `到 ${server.host} 的网络不可达：检查本机网络，或这个 IP 是不是 IPv6 而本机没有 IPv6`;
  if (/ECONNRESET/.test(m)) return `连接被重置：常见于国内到 VPS 的 SSH 被干扰，可开着代理软件再试`;
  if (/timed? ?out|超时/i.test(m)) return `连不上 ${where}：服务器关机、IP 被墙，或云厂商安全组/防火墙没放行 SSH 端口`;
  return 'SSH 连接失败：' + m;
}

class SSH {
  constructor(server) {
    this.server = server;
    this.conn = null;
    this.via = null; // 经过的代理
    this.sudo = server.username && server.username !== 'root';
  }

  connect({ sock, readyTimeout = 15000 } = {}) {
    const s = this.server;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => { conn.end(); reject(new Error('SSH 连接超时')); }, readyTimeout + 5000);
      let seen = ''; let mismatch = false;
      conn.on('ready', () => {
        clearTimeout(timer); this.conn = conn; this.hostKey = seen;
        if (seen && !s.hostKey) { s.hostKey = seen; try { hostKeySaver(s, seen); } catch (_) { /* ignore */ } }
        resolve(this);
      });
      conn.on('error', (e) => { clearTimeout(timer); reject(mismatch ? mismatchError(s, seen) : e); });
      const opts = {
        host: s.host, port: Number(s.sshPort) || 22, username: s.username || 'root',
        readyTimeout, keepaliveInterval: 15000,
        // 在发送密码之前核对主机指纹
        hostVerifier: (key) => {
          seen = fingerprint(key);
          if (s.hostKey && s.hostKey !== seen) { mismatch = true; return false; }
          return true;
        },
      };
      if (sock) opts.sock = sock;
      if (s.authType === 'key') {
        opts.privateKey = s.privateKey;
        if (s.passphrase) opts.passphrase = s.passphrase;
      } else {
        opts.password = s.password;
        opts.tryKeyboard = true;
        conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([s.password]));
      }
      try { conn.connect(opts); } catch (e) { clearTimeout(timer); reject(e); }
    });
  }

  // 先直连；超时或被重置时自动改走本机代理（密码错误不重试）
  async connectSmart(log = () => {}) {
    const s = this.server;
    const port = Number(s.sshPort) || 22;
    const key = `${s.host}:${port}`;
    const order = preferProxy.get(key) ? ['proxy', 'direct'] : ['direct', 'proxy'];
    let lastErr = null;
    let triedProxy = false;
    for (const mode of order) {
      if (mode === 'direct') {
        try { await this.connect({ readyTimeout: 12000 }); preferProxy.delete(key); return this; } catch (e) {
          if (e.hostKeyMismatch) throw e;
          if (isAuthError(e)) throw new Error(friendlyError(e, s));
          lastErr = e;
          continue;
        }
      }
      const proxies = await proxyProvider(s).catch(() => []);
      for (const p of proxies) {
        triedProxy = true;
        let sock;
        try {
          sock = await openTunnel(p, s.host, port);
          await this.connect({ sock, readyTimeout: 20000 });
          this.via = proxyLabel(p);
          preferProxy.set(key, true);
          log(`直连不通，已改走本机代理 ${this.via}`);
          return this;
        } catch (e) {
          if (sock) sock.destroy();
          if (e.hostKeyMismatch) throw e;
          if (isAuthError(e)) throw new Error(friendlyError(e, s));
          if (!lastErr) lastErr = e;
        }
      }
    }
    let msg = friendlyError(lastErr, s);
    if (!triedProxy) msg += '（本机没有检测到代理软件；国内连 VPS 不稳定时，可以先打开 V2rayN / Clash 再试）';
    else msg += '（直连和经本机代理都失败了）';
    throw new Error(msg);
  }

  // 执行命令（POSIX sh，兼容没有 bash 的 Alpine）；root 权限需要时自动加 sudo -n
  exec(cmd, { input, onData, root = true, timeout = 600000 } = {}) {
    const full = root && this.sudo ? `sudo -n sh -c ${shq(cmd)}` : `sh -c ${shq(cmd)}`;
    return new Promise((resolve, reject) => {
      this.conn.exec(full, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        // 按 UTF-8 流式解码：一个汉字被拆在两个数据包里时不会变成乱码
        const dOut = new StringDecoder('utf8');
        const dErr = new StringDecoder('utf8');
        const timer = setTimeout(() => { stream.close(); reject(new Error('命令执行超时')); }, timeout);
        stream.on('data', (d) => { const t = dOut.write(d); stdout += t; onData && t && onData(t); });
        stream.stderr.on('data', (d) => { const t = dErr.write(d); stderr += t; onData && t && onData(t); });
        stream.on('close', (code) => { clearTimeout(timer); stdout += dOut.end(); stderr += dErr.end(); resolve({ code, stdout, stderr }); });
        if (input !== undefined) stream.end(input); else stream.end();
      });
    });
  }

  async run(cmd, opts) {
    const r = await this.exec(cmd, opts);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `退出码 ${r.code}`).trim().slice(-2000));
    return r.stdout;
  }

  async writeFile(path, data, mode = '600') {
    await this.run(`umask 077; cat > ${shq(path + '.tmp')} && chmod ${mode} ${shq(path + '.tmp')} && mv -f ${shq(path + '.tmp')} ${shq(path)}`, { input: data });
  }

  // 上传 gzip 数据并解压到目标路径
  async writeGz(path, gzBuffer, mode = '755') {
    await this.run(`gunzip -c > ${shq(path + '.tmp')} && chmod ${mode} ${shq(path + '.tmp')} && mv -f ${shq(path + '.tmp')} ${shq(path)}`, { input: gzBuffer });
  }

  end() { try { this.conn && this.conn.end(); } catch (_) { /* ignore */ } }
}

async function withSSH(server, fn, { log } = {}) {
  const ssh = new SSH(server);
  await ssh.connectSmart(log);
  try { return await fn(ssh); } finally { ssh.end(); }
}

module.exports = { SSH, withSSH, shq, setProxyProvider, setHostKeySaver, friendlyError, fingerprint };
