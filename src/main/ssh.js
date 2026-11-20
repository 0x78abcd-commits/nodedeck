'use strict';
const { Client } = require('ssh2');

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

class SSH {
  constructor(server) {
    this.server = server;
    this.conn = null;
    this.sudo = server.username && server.username !== 'root';
  }

  connect() {
    const s = this.server;
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => { conn.end(); reject(new Error('SSH 连接超时')); }, 25000);
      conn.on('ready', () => { clearTimeout(timer); this.conn = conn; resolve(this); });
      conn.on('error', (e) => { clearTimeout(timer); reject(new Error('SSH 连接失败：' + e.message)); });
      const opts = {
        host: s.host, port: Number(s.sshPort) || 22, username: s.username || 'root',
        readyTimeout: 20000, keepaliveInterval: 15000,
      };
      if (s.authType === 'key') {
        opts.privateKey = s.privateKey;
        if (s.passphrase) opts.passphrase = s.passphrase;
      } else {
        opts.password = s.password;
        opts.tryKeyboard = true;
        conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([s.password]));
      }
      conn.connect(opts);
    });
  }

  // 执行命令；root 权限需要时自动加 sudo -n
  exec(cmd, { input, onData, root = true, timeout = 600000 } = {}) {
    const full = root && this.sudo ? `sudo -n bash -c ${shq(cmd)}` : `bash -c ${shq(cmd)}`;
    return new Promise((resolve, reject) => {
      this.conn.exec(full, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { stream.close(); reject(new Error('命令执行超时')); }, timeout);
        stream.on('data', (d) => { const t = d.toString(); stdout += t; onData && onData(t); });
        stream.stderr.on('data', (d) => { const t = d.toString(); stderr += t; onData && onData(t); });
        stream.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
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

async function withSSH(server, fn) {
  const ssh = new SSH(server);
  await ssh.connect();
  try { return await fn(ssh); } finally { ssh.end(); }
}

module.exports = { SSH, withSSH, shq };
