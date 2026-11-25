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

// 去掉颜色码和时间戳，只留最后一条 sing-box 报错
function lastSingboxError(text) {
  const lines = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /\b(ERROR|FATAL|WARN)\b|\[(Error|Warning)\]/.test(l));
  const l = errs[errs.length - 1] || lines[lines.length - 1] || '';
  return l.replace(/^\d{4}\/\d\d\/\d\d [\d:.]+ \[(Error|Warning|Info)\]\s*/, '').replace(/^[-+\d:. TZ]*\s*(ERROR|FATAL|WARN)\s*(\[\d+\s*\d*ms\]\s*)?(\[[^\]]*\]\s*)*/, '').replace(/\s*\[\d+ \d+ms\]\s*/, ' ').slice(0, 300);
}

function explainError(msg, stderr, outbound) {
  const detail = lastSingboxError(stderr);
  let out = msg.replace(/\x1b\[[0-9;]*m/g, '');
  if (detail && !out.includes(detail)) out += '\n' + detail;
  const reset = /RESET|forcibly closed|connection reset|EOF/i.test(msg + ' ' + detail);
  const reality = outbound?.tls?.reality?.enabled || outbound?.streamSettings?.security === 'reality';
  const rsni = outbound?.tls?.server_name || outbound?.streamSettings?.realitySettings?.serverName || '';
  if (reset && reality) {
    out += `\n可能原因：连上之后被掐断，多半是 Reality 目标 ${rsni} 在国内被屏蔽或被针对（同一台的其它协议能通说明 IP 没被墙）。在服务器「更多」里点「重新优选 Reality 目标」，或者把目标换成主流大站（如 www.apple.com），同步后再测`;
  } else if (reset) {
    out += '\n可能原因：连上之后被掐断，常见于端口被针对或协议特征被识别，可以试试「一键换新」换端口';
  }
  return out;
}

// fetchVia(proxyPort, url, timeoutMs) => Response，由主进程注入（使用 Electron 独立 session + 代理）
// xrayPath 给了就用 Xray 跑（XHTTP 节点，outbound 是 Xray 格式），否则用 sing-box
async function testOutbound({ singboxPath, xrayPath, outbound, fetchVia }) {
  if (!outbound) return { ok: false, error: '这个协议不支持本地测试' };
  const port = await freePort();
  const cfgFile = path.join(os.tmpdir(), `nodedeck-test-${port}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(xrayPath ? core.xrayTestConfig(outbound, port) : core.clientTestConfig(outbound, port)));
  let stderr = '';
  const proc = spawn(xrayPath || singboxPath, ['run', '-c', cfgFile], { windowsHide: true });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.stdout.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((r) => proc.once('exit', r));
  try {
    const ready = await Promise.race([waitPort(port), exited.then(() => false)]);
    if (!ready) throw new Error(`本地 ${xrayPath ? 'Xray' : 'sing-box'} 启动失败：` + stderr.trim().slice(-500));
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
    return { ok: false, error: explainError(e.message || String(e), stderr, outbound) };
  } finally {
    proc.kill();
    setTimeout(() => fs.rm(cfgFile, { force: true }, () => {}), 1000);
  }
}

module.exports = { testOutbound, freePort, lastSingboxError };
