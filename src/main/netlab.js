// 从这台电脑测到 VPS 的网络：TCP 下载 / 上传速度、UDP 丢包和抖动、去程路由。
// 测的是「你家网络 ↔ VPS」这一段，用户实际用的就是这一段。测速会消耗 VPS 流量（每次约 100MB）。
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DOWN_SECONDS = 8;
const UP_SECONDS = 8;

function speedBase(state, server) {
  return { host: server.host, port: Number(state.settings?.subPort || 2096), token: server.speedToken };
}

// 下载测速：streams 条连接同时下载，测到第 secs 秒为止，跳过最开始 1 秒（TCP 慢启动），返回合计 Mbps。
// 单线程反映一条连接能跑多快（看视频、下载单个文件），多线程接近线路带宽（做法和 LibreSpeed / Speedtest 一样）
function downloadTest(base, secs = DOWN_SECONDS, streams = 1) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let ttfb = 0; let bytes = 0; let mark = 0; let markBytes = 0; let done = false; let firstErr = null; let open = streams;
    const reqs = [];
    const tick = () => {
      if (!ttfb) return;
      const el = Date.now() - t0 - ttfb;
      if (!mark && el >= 1000) { mark = Date.now(); markBytes = bytes; }
      if (el >= secs * 1000) finish();
    };
    for (let k = 0; k < streams; k++) {
      const req = http.get({ host: base.host, port: base.port, path: `/nd-speed/down?t=${encodeURIComponent(base.token)}&bytes=${256 << 20}&s=${k}`, agent: false, timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) { firstErr ||= new Error(`VPS 返回 ${res.statusCode}`); res.resume(); closed(); return; }
        if (!ttfb) ttfb = Date.now() - t0;
        res.on('data', (c) => { bytes += c.length; tick(); });
        res.on('end', closed);
        res.on('error', closed);
      });
      req.on('timeout', () => { firstErr ||= new Error('连接超时'); req.destroy(); });
      req.on('error', (e) => { firstErr ||= e; closed(); });
      reqs.push(req);
    }
    function closed() { if (--open <= 0) finish(); }
    function finish() {
      if (done) return; done = true;
      for (const r of reqs) { try { r.destroy(); } catch (_) { /* ignore */ } }
      if (!bytes) { resolve({ error: (firstErr || new Error('没收到数据')).message, streams }); return; }
      const end = Date.now();
      const useBytes = mark ? bytes - markBytes : bytes;
      const useMs = mark ? end - mark : end - t0 - ttfb;
      resolve({ mbps: useMs > 0 ? (useBytes * 8) / useMs / 1000 : 0, bytes, ms: end - t0, ttfbMs: ttfb, streams });
    }
  });
}

// 上传测速：边生成边发，发够 secs 秒；速度用 VPS 实际收到的字节算，跳过最开始 1 秒（新版 agent 会给出）
function uploadOnce(base, secs, k) {
  return new Promise((resolve) => {
    const chunk = crypto.randomBytes(64 * 1024);
    const t0 = Date.now(); let sent = 0; let done = false;
    const req = http.request({ host: base.host, port: base.port, method: 'POST', path: `/nd-speed/up?t=${encodeURIComponent(base.token)}&s=${k}`, agent: false, timeout: 20000, headers: { 'Content-Type': 'application/octet-stream' } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (done) return; done = true;
        if (res.statusCode !== 200) { resolve({ error: `VPS 返回 ${res.statusCode}` }); return; }
        let j = {}; try { j = JSON.parse(body); } catch (_) { /* ignore */ }
        resolve({ bytes: j.bytes || sent, ms: Date.now() - t0, steadyBytes: j.steadyBytes, steadyMs: j.steadyMs });
      });
    });
    req.on('error', (e) => { if (!done) { done = true; resolve({ error: e.message }); } });
    req.on('timeout', () => req.destroy(new Error('超时')));
    const pump = () => {
      while (Date.now() - t0 < secs * 1000 && sent < (256 << 20)) {
        sent += chunk.length;
        if (!req.write(chunk)) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
}

async function uploadTest(base, secs = UP_SECONDS, streams = 1) {
  const rs = await Promise.all(Array.from({ length: streams }, (_, k) => uploadOnce(base, secs, k)));
  const ok = rs.filter((r) => !r.error);
  if (!ok.length) return { error: rs[0].error, streams };
  const bytes = ok.reduce((a, r) => a + r.bytes, 0);
  // 新版 agent：各连接稳定段的字节数相加，除以稳定段的时长（取各连接里最长的）
  if (ok.every((r) => r.steadyMs > 0)) {
    const sb = ok.reduce((a, r) => a + r.steadyBytes, 0);
    const ms = Math.max(...ok.map((r) => r.steadyMs));
    return { mbps: (sb * 8) / ms / 1000, bytes, ms, streams };
  }
  const ms = Math.max(...ok.map((r) => r.ms));
  return { mbps: (bytes * 8) / ms / 1000, bytes, ms, streams };
}

async function speedTest(state, server, { down = true, up = true } = {}) {
  const base = speedBase(state, server);
  const out = { at: Date.now() };
  if (down) { out.down = await downloadTest(base); out.downMulti = await downloadTest(base, DOWN_SECONDS, 4); }
  if (up) { out.up = await uploadTest(base); out.upMulti = await uploadTest(base, UP_SECONDS, 4); }
  return out;
}

// UDP：每 20ms 发一个 1200 字节的包（和 QUIC 包差不多大），共 count 个，看回来多少、延迟和抖动
function udpTest(state, server, { count = 250, size = 1200, gap = 20 } = {}) {
  const base = speedBase(state, server);
  return new Promise((resolve) => {
    const sock = dgram.createSocket(server.host.includes(':') ? 'udp6' : 'udp4');
    const tok = Buffer.from(String(base.token).slice(0, 16));
    const sentAt = new Array(count).fill(0);
    const rtt = new Array(count).fill(-1);
    let i = 0; let finished = false;
    sock.on('message', (m) => {
      if (m.length < 20 || !m.subarray(0, 16).equals(tok)) return;
      const seq = m.readUInt32BE(16);
      if (seq < count && rtt[seq] < 0 && sentAt[seq]) rtt[seq] = Number(process.hrtime.bigint() - BigInt(sentAt[seq])) / 1e6;
    });
    sock.on('error', (e) => end(e));
    const send = () => {
      if (i >= count) { setTimeout(() => end(), 2000); return; }
      const b = Buffer.alloc(size);
      tok.copy(b, 0); b.writeUInt32BE(i, 16);
      sentAt[i] = process.hrtime.bigint().toString();
      sock.send(b, base.port, base.host);
      i++;
      setTimeout(send, gap);
    };
    send();
    function end(err) {
      if (finished) return; finished = true;
      try { sock.close(); } catch (_) { /* ignore */ }
      const ok = rtt.filter((v) => v >= 0);
      if (!ok.length) { resolve({ error: err ? err.message : '一个包都没回来：UDP 可能被拦截，或者 VPS 防火墙没放行（先点一次「同步」）', loss: 100, sent: count, recv: 0 }); return; }
      let j = 0; let jn = 0; let prev = -1;
      for (const v of rtt) { if (v < 0) continue; if (prev >= 0) { j += Math.abs(v - prev); jn++; } prev = v; }
      const sorted = [...ok].sort((a, b) => a - b);
      // 连续丢包（突发丢包对 QUIC 影响更大）
      let burst = 0; let cur = 0;
      for (const v of rtt) { if (v < 0) { cur++; burst = Math.max(burst, cur); } else cur = 0; }
      resolve({ sent: count, recv: ok.length, loss: (100 * (count - ok.length)) / count, avg: ok.reduce((a, b) => a + b, 0) / ok.length, min: sorted[0], p95: sorted[Math.floor(sorted.length * 0.95)], jitter: jn ? j / jn : 0, maxBurst: burst, size, at: Date.now() });
    }
  });
}

// 去程路由：在这台电脑上跑系统自带的路由追踪（Windows 的 tracert）
function forwardTrace(host) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const cmd = win ? 'tracert' : 'traceroute';
    const args = win ? ['-d', '-w', '800', '-h', '30', host] : ['-n', '-w', '1', '-q', '1', '-m', '30', host];
    const bufs = [];
    let p;
    try { p = spawn(cmd, args, { windowsHide: true }); } catch (e) { resolve({ error: e.message }); return; }
    const timer = setTimeout(() => { try { p.kill(); } catch (_) { /* ignore */ } }, 120000);
    p.stdout.on('data', (d) => bufs.push(d));
    p.on('error', (e) => { clearTimeout(timer); resolve({ error: `没法运行 ${cmd}：${e.message}` }); });
    p.on('close', () => {
      clearTimeout(timer);
      // 中文 Windows 的 tracert 输出是 GBK；IP 和 ms 都是 ASCII，解码失败也不影响解析
      let out;
      try { out = new TextDecoder(win ? 'gbk' : 'utf-8').decode(Buffer.concat(bufs)); } catch (_) { out = Buffer.concat(bufs).toString(); }
      const hops = [];
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m) continue;
        const ips = m[2].match(/\d+\.\d+\.\d+\.\d+/g) || [];
        const ms = (m[2].match(/(<?\d+(?:\.\d+)?)\s*ms/g) || []).map((x) => parseFloat(x.replace('<', '')));
        hops.push({ ttl: Number(m[1]), ip: ips[ips.length - 1] || '*', ms: ms.length ? Math.min(...ms) : 0 });
      }
      const [line, lineTip] = classifyRoute(hops);
      resolve({ hops, line, lineTip, reached: hops.some((h) => h.ip === host) });
    });
  });
}

// 和 agent 里的判断规则一致（agent/icmp.go classifyRoute，参考 oneclickvirt/backtrace）：每跳归到骨干网 ASN，按先后顺序判断
function hopASN(ip) {
  const m = String(ip).match(/^(\d+)\.(\d+)\.(\d+)\./);
  if (!m) return '';
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a === 59 && b === 43) return 'AS4809';
  if (a === 202 && b === 97) return 'AS4134';
  if ((a === 218 && b === 105) || (a === 210 && b === 51)) return 'AS9929';
  if ((a === 202 && b === 77) || (a === 43 && b === 252) || (a === 61 && b === 14)) return 'AS10099';
  if (a === 219 && b === 158) return 'AS4837';
  if (a === 223 && ((b === 118 && c === 32) || (b === 120 && c >= 128) || (b === 119 && [8, 9, 10, 11, 12, 13, 14, 15, 26, 27, 28, 29, 32, 33, 34, 35, 36, 37, 74, 75, 88, 89, 100, 252, 253].includes(c)))) return 'AS58807';
  if (a === 223 && b >= 118 && b <= 121) return 'AS58453';
  if ((a === 221 && b === 183) || (a === 111 && b === 24)) return 'AS9808';
  if ((a === 69 && b === 194) || (a === 203 && b === 22)) return 'AS23764';
  return '';
}
function classifyRoute(hops, carrier = '') {
  const asns = hops.map((h) => hopASN(h.ip)).filter(Boolean);
  const pos = (t) => { const first = asns.indexOf(t); return [first, asns.filter((x) => x === t).length]; };
  if (!carrier && asns.length) carrier = ['AS4809', 'AS4134', 'AS23764'].includes(asns[0]) ? 'CT' : ['AS9929', 'AS10099', 'AS4837'].includes(asns[0]) ? 'CU' : 'CM';
  if (carrier === 'CT') {
    const [cn2, cn2N] = pos('AS4809'); const [ct, ctN] = pos('AS4134'); const [ctg] = pos('AS23764');
    if (cn2 >= 0) {
      if (cn2N < 2) return ['CN2 混合', '只经过一跳 CN2，其余走 163，比纯 163 好，晚高峰一般'];
      if (ct < 0 || (cn2 < ct && ctN <= 1)) return ['CN2 GIA', '电信最高端的国际线路，全程 CN2，晚高峰也稳'];
      if (cn2 < ct) return ['CN2 混合', '先走 CN2、之后又走了好几跳 163，晚高峰一般'];
      return ['CN2 GT', '出国段走 163、国内段走 CN2，晚高峰一般'];
    }
    if (ctg >= 0) return ['电信 CTGNET', '电信国际精品网，质量好'];
    if (ctN >= 2) return ['电信 163', '电信普通国际线路，晚高峰容易拥堵'];
  } else if (carrier === 'CU') {
    const [u9929] = pos('AS9929'); const [cug] = pos('AS10099'); const [u4837, u4837N] = pos('AS4837');
    if (u9929 >= 0) return u4837 >= 0 && u4837 < u9929 ? ['联通 9929 混合', '一段走 4837、一段走 9929，比纯 4837 好'] : ['联通 9929', '联通精品网（CUII），质量好'];
    if (cug >= 0) return ['联通 CUG（10099）', '联通国际精品网，质量较好'];
    if (u4837N >= 2) return ['联通 4837', '联通普通国际线路，晚高峰容易拥堵'];
  } else if (carrier === 'CM') {
    const [cmin2] = pos('AS58807'); const [cmi] = pos('AS58453'); const [cmnet] = pos('AS9808');
    if (cmin2 >= 0) return cmi >= 0 && cmi < cmin2 ? ['移动 CMIN2 混合', '一段走 CMI、一段走 CMIN2，质量较好'] : ['移动 CMIN2', '移动精品国际线路，质量好'];
    if (cmi >= 0) return ['移动 CMI', '移动普通国际线路，多数地区不错，晚高峰看运气'];
    if (cmnet >= 0) return ['移动 CMNET', '移动普通骨干网'];
  }
  return ['未识别', '路径里没有看到常见的骨干网地址（可能中间节点不回应，或者你用了代理）'];
}

// 晚高峰报告：用 agent 的 7 天小时级数据，按服务器设置的时区分晚高峰（20~23 点）和其它时段
function peakReport(series, tz = 'Asia/Shanghai') {
  const hourOf = (t) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(t * 1000)));
  const acc = {};
  for (const s of series || []) {
    const peak = [20, 21, 22, 23].includes(hourOf(s.t));
    for (const k of Object.keys(s.lat || {})) {
      const a = (acc[k] ||= { peak: { lat: [], loss: [], jit: [] }, off: { lat: [], loss: [], jit: [] } });
      const b = peak ? a.peak : a.off;
      if (s.lat[k] > 0) b.lat.push(s.lat[k]);
      if (s.loss && s.loss[k] != null) b.loss.push(s.loss[k]);
      if (s.jit && s.jit[k] != null) b.jit.push(s.jit[k]);
    }
  }
  const avg = (v) => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : null);
  const out = {};
  for (const [k, a] of Object.entries(acc)) {
    out[k] = {
      peak: { lat: avg(a.peak.lat), loss: avg(a.peak.loss), jit: avg(a.peak.jit), n: a.peak.lat.length },
      off: { lat: avg(a.off.lat), loss: avg(a.off.loss), jit: avg(a.off.jit), n: a.off.lat.length },
    };
  }
  return out;
}

// Hysteria2 / TUIC 建议：根据 UDP 丢包和测速结果
function quicAdvice(server, udp, speed) {
  const tips = [];
  const hy = server.protocols?.hysteria2;
  if (!udp || udp.error) {
    tips.push({ level: 'bad', text: 'UDP 测不通：Hysteria2 / TUIC 很可能用不了（运营商或公司网络封了 UDP / QUIC）。这种网络下请用 Reality、Trojan 这类 TCP 协议' });
    return tips;
  }
  if (udp.loss >= 10) tips.push({ level: 'bad', text: `UDP 丢包 ${udp.loss.toFixed(1)}%，很高：运营商可能在对 UDP 限速（QoS）。建议开启 Hysteria2 的混淆和端口跳跃，或者改用 TCP 协议`, action: hy?.enabled && (!hy.obfs || !hy.hopPorts) ? 'antiqos' : null });
  else if (udp.loss >= 3) tips.push({ level: 'warn', text: `UDP 丢包 ${udp.loss.toFixed(1)}%，偏高：晚高峰可能更差。开启混淆和端口跳跃能缓解运营商对 UDP 的限速`, action: hy?.enabled && (!hy.obfs || !hy.hopPorts) ? 'antiqos' : null });
  else tips.push({ level: 'ok', text: `UDP 丢包 ${udp.loss.toFixed(1)}%，正常，Hysteria2 / TUIC 可以放心用` });
  if (udp.maxBurst >= 5) tips.push({ level: 'warn', text: `出现连续 ${udp.maxBurst} 个包一起丢，说明线路有突发拥堵，QUIC 会卡一下` });
  const down = speed?.downMulti?.mbps || speed?.down?.mbps; const up = speed?.upMulti?.mbps || speed?.up?.mbps;
  if (down > 0 && up > 0) {
    const d = Math.max(5, Math.floor(down * 0.85)); const u = Math.max(5, Math.floor(up * 0.85));
    tips.push({ level: 'info', text: `你这边测到下载约 ${down.toFixed(0)} Mbps、上传约 ${up.toFixed(0)} Mbps。如果在客户端里给 Hysteria2 填带宽，建议填下行 ${d}、上行 ${u}（实测的 85%）；填得比实际高会疯狂发包、反而被限速。不填就自动用 BBR，也可以` });
    const cap = Number(hy?.upMbps) || 0;
    if (hy?.enabled && cap > 0 && cap < down * 0.5) tips.push({ level: 'warn', text: `服务端 Hysteria2 上行上限设成了 ${cap} Mbps，比实测下载速度低很多，会把速度卡住。可以改成 0（不限）`, action: 'hycap0' });
  }
  const tuic = server.protocols?.tuic;
  if (tuic?.enabled) tips.push({ level: 'ok', text: 'TUIC 用的是 BBR 拥塞控制（QUIC 自己的，不是内核那个），适合长距离线路，不用改' });
  return tips;
}

module.exports = { speedTest, downloadTest, udpTest, forwardTrace, classifyRoute, peakReport, quicAdvice, speedBase };
