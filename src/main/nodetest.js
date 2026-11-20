'use strict';
// 本地启动一个 sing-box 客户端，通过节点测延迟和出口 IP
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const core = require('./core');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function waitPort(port, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// fetchVia(proxyPort, url, timeoutMs) => Response，由主进程注入（使用 Electron 独立 session + 代理）
async function testOutbound({ singboxPath, outbound, fetchVia }) {
  const port = await freePort();
  const cfgFile = path.join(os.tmpdir(), `nodedeck-test-${port}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(core.clientTestConfig(outbound, port)));
  let stderr = '';
  const proc = spawn(singboxPath, ['run', '-c', cfgFile], { windowsHide: true });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.stdout.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((r) => proc.once('exit', r));
  try {
    const ready = await Promise.race([waitPort(port), exited.then(() => false)]);
    if (!ready) throw new Error('本地 sing-box 启动失败：' + stderr.trim().slice(-500));
    const result = { ok: false, latency: null, ip: null, error: '' };
    // 延迟：取两次中较小值（第一次包含握手）
    const lat = [];
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const r = await fetchVia(port, 'https://www.gstatic.com/generate_204', 8000);
      if (r.status !== 204 && r.status !== 200) throw new Error('HTTP ' + r.status);
      lat.push(Date.now() - t0);
    }
    result.latency = Math.min(...lat);
    try {
      const r = await fetchVia(port, 'http://ip-api.com/json/?fields=query,country,city,isp,as,hosting,proxy,mobile&lang=zh-CN', 8000);
      result.ip = await r.json();
    } catch (e) { result.ipError = e.message; }
    result.ok = true;
    return result;
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + (stderr ? '\n' + stderr.trim().slice(-300) : '') };
  } finally {
    proc.kill();
    setTimeout(() => fs.rm(cfgFile, { force: true }, () => {}), 1000);
  }
}

module.exports = { testOutbound, freePort };
