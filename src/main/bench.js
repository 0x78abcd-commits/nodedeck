'use strict';
// 网络优化（agent 命令的包装）和社区测试脚本（NodeQuality / TcpQuality）
const { withSSH, shq } = require('./ssh');
const { DIR, agentJSON } = require('./units');

// ---------- 网络优化（agent 命令的包装）----------
const netInfo = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-info -c ${DIR}/agent.json`));
const netTune = (server, keys = []) => withSSH(server, (ssh) => agentJSON(ssh, `net-tune -c ${DIR}/agent.json${keys.length ? ' -domains ' + shq(keys.join(',')) : ''}`));
const netRestore = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-restore -c ${DIR}/agent.json`));
const netTrace = (server) => withSSH(server, (ssh) => agentJSON(ssh, `trace -c ${DIR}/agent.json`, 180000));
const netPing = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-ping -c ${DIR}/agent.json`, 60000));
const netMtu = (server) => withSSH(server, (ssh) => agentJSON(ssh, `net-mtu -c ${DIR}/agent.json`, 120000));
const netTcp = (ssh) => agentJSON(ssh, `net-tcp -c ${DIR}/agent.json`);
const netSetCC = (ssh, cc) => agentJSON(ssh, `net-cc -c ${DIR}/agent.json -text ${shq(cc)}`);

// ---------- 社区测试脚本（NodeQuality / TcpQuality）：在 VPS 后台运行，断开 SSH 也不影响 ----------
const BENCH_DIR = '/root/.nodedeck-bench';
const BENCH = {
  nodequality: (o) => `printf '%s\\n' ${shq(o.hq || 'f')} ${shq(o.iq || 'y')} ${shq(o.nq || 'l')} ${shq(o.bt || 'y')} n n n n | bash <(curl -sL https://run.NodeQuality.com)`,
  tcpquality: (o) => `bash <(curl -fsSL https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh)${o.speedtest ? ' --speedtest' : ''}${o.v4 ? ' -v4' : ''}`,
};
const BENCH_URL = /https?:\/\/(?:www\.)?(?:nodequality\.com|tcpquality\.ibsgss\.uk)\/r\/[A-Za-z0-9_-]+/g;

async function benchStart(server, kind, opts = {}) {
  if (!BENCH[kind]) throw new Error('未知的测试');
  return withSSH(server, async (ssh) => {
    // 精简系统常常没装 curl（Debian 最小安装只有 wget），测试脚本要用：缺了就先装上
    const need = await ssh.exec('command -v bash >/dev/null && command -v curl >/dev/null && echo OK');
    if (!need.stdout.includes('OK')) {
      await ssh.exec(`if command -v apt-get >/dev/null; then (apt-get update -qq || true) && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl bash; elif command -v dnf >/dev/null; then dnf install -y -q curl bash; elif command -v yum >/dev/null; then yum install -y -q curl bash; elif command -v apk >/dev/null; then apk add --no-cache -q curl bash; fi`, { timeout: 240000 });
    }
    const chk = await ssh.exec(`command -v bash >/dev/null && command -v curl >/dev/null && echo OK; df -Pm /root | awk 'NR==2{print $4}'; [ -f ${BENCH_DIR}/${kind}.pid ] && kill -0 "$(cat ${BENCH_DIR}/${kind}.pid)" 2>/dev/null && echo RUNNING`);
    if (!chk.stdout.includes('OK')) throw new Error('VPS 上缺少 bash 或 curl，自动安装也失败了。可以 SSH 登录后手动安装（Debian / Ubuntu：apt install curl；Alpine：apk add bash curl）');
    if (chk.stdout.includes('RUNNING')) return { running: true, already: true };
    const free = Number((chk.stdout.match(/^\d+$/m) || [0])[0]);
    if (free && free < 1024) throw new Error(`磁盘只剩 ${free}MB，测试脚本需要下载临时系统，至少要 1GB 空闲`);
    const script = `#!/bin/bash\nexport TERM=xterm LANG=C.UTF-8\ncd ${BENCH_DIR}\n${BENCH[kind](opts)}\nrc=$?\necho\necho "[nodedeck] 测试结束（退出码 $rc）"\n`;
    await ssh.run(`mkdir -p ${BENCH_DIR} && chmod 700 ${BENCH_DIR}`);
    await ssh.writeFile(`${BENCH_DIR}/${kind}.sh`, script, '700');
    await ssh.run(`cd ${BENCH_DIR} && : > ${kind}.log && (setsid nohup bash ${kind}.sh > ${kind}.log 2>&1 < /dev/null & echo $! > ${kind}.pid)`);
    return { running: true };
  });
}

// 读取后台测试的输出（从 offset 开始），返回去掉颜色码的文本、是否还在运行、报告链接
async function benchPoll(server, kind, offset = 0) {
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`f=${BENCH_DIR}/${kind}.log; [ -f "$f" ] || { echo NOLOG; exit 0; }; s=$(wc -c < "$f"); echo "SIZE=$s"; echo "START=$(stat -c %Y ${BENCH_DIR}/${kind}.pid 2>/dev/null)"; echo "END=$(stat -c %Y "$f")"; echo "NOW=$(date +%s)"; ( [ -f ${BENCH_DIR}/${kind}.pid ] && kill -0 "$(cat ${BENCH_DIR}/${kind}.pid)" 2>/dev/null ) && echo RUN=1 || echo RUN=0; echo ---; tail -c +$(( ${Number(offset) || 0} + 1 )) "$f" | head -c 200000`);
    if (r.stdout.startsWith('NOLOG')) return { none: true };
    const [head, ...rest] = r.stdout.split('\n---\n');
    const total = Number((head.match(/SIZE=(\d+)/) || [])[1] || 0);
    const running = /RUN=1/.test(head);
    let raw = rest.join('\n---\n');
    // 只取到最后一个换行为止：避免把一个汉字从中间切开，也避免一次读不完（最多 200KB）时丢掉后面的内容
    const cut = Math.max(raw.lastIndexOf('\n'), raw.lastIndexOf('\r'));
    if (running || total > (Number(offset) || 0) + Buffer.byteLength(raw)) raw = cut >= 0 ? raw.slice(0, cut + 1) : '';
    const size = (Number(offset) || 0) + Buffer.byteLength(raw);
    // 保留单独的 \r（进度条原地刷新），界面那边按终端的方式处理
    const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r\n/g, '\n');
    const all = (await ssh.exec(`cat ${BENCH_DIR}/${kind}.log 2>/dev/null | tr -d '\\033'`)).stdout;
    const urls = [...new Set(all.match(BENCH_URL) || [])];
    const num = (k) => Number((head.match(new RegExp(k + '=(\\d+)')) || [])[1] || 0);
    // 用时：按 VPS 的时钟算（开始 = pid 文件时间，结束 = 日志最后写入时间）
    const elapsed = num('START') ? (running ? num('NOW') : num('END')) - num('START') : 0;
    return { size, running, text, url: urls[urls.length - 1] || '', elapsed: Math.max(0, elapsed) };
  });
}

async function benchStop(server, kind) {
  return withSSH(server, (ssh) => ssh.exec(`[ -f ${BENCH_DIR}/${kind}.pid ] && kill -INT -"$(cat ${BENCH_DIR}/${kind}.pid)" 2>/dev/null; kill "$(cat ${BENCH_DIR}/${kind}.pid 2>/dev/null)" 2>/dev/null; true`));
}

module.exports = { netInfo, netTune, netRestore, netTrace, netPing, netMtu, netTcp, netSetCC, benchStart, benchPoll, benchStop };
