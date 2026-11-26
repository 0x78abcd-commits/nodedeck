'use strict';
// 清理 VPS 上的其他面板 / 代理程序（不重装系统），可选备份和一键恢复
const { withSSH, shq } = require('./ssh');
const { SB_BIN } = require('./units');

// ---------- 清理其他面板 / 代理程序（不重装系统）----------
// 只认识下面这些常见的面板和代理程序，只删这里列出的服务和目录。默认彻底删除；勾选备份时整套（程序、配置、
// 服务文件、定时任务）打包到 /root/nodedeck-backup/<时间>/，之后可以在 NodeDeck 里一键恢复。
// detect：判断装没装用的路径（默认就是 paths）；markers：服务文件内容里出现这些目录也算它的服务；
// extraPaths：运行时才知道的路径（shell 片段，每行输出一个）；pre：删除前要做的事（shell 片段）
const OTHER_APPS = [
  { id: 'x-ui', name: 'x-ui / 3x-ui 面板', units: ['x-ui'], paths: ['/usr/local/x-ui', '/etc/x-ui', '/usr/bin/x-ui'] },
  { id: 's-ui', name: 's-ui 面板', units: ['s-ui'], paths: ['/usr/local/s-ui', '/usr/bin/s-ui'] },
  { id: 'h-ui', name: 'h-ui 面板', units: ['h-ui'], paths: ['/usr/local/h-ui'] },
  { id: 'xray', name: 'Xray', units: ['xray', 'xray@*'], paths: ['/usr/local/bin/xray', '/usr/local/etc/xray', '/usr/local/share/xray', '/var/log/xray', '/etc/xray', '/usr/local/xray'] },
  { id: 'v2ray', name: 'V2Ray', units: ['v2ray', 'v2ray@*'], paths: ['/usr/local/bin/v2ray', '/usr/local/bin/v2ctl', '/usr/local/etc/v2ray', '/usr/local/share/v2ray', '/var/log/v2ray', '/etc/v2ray', '/usr/bin/v2ray'] },
  { id: 'sing-box', name: 'sing-box（其他脚本装的）', units: ['sing-box', 'sing-box@*', 'sb'], paths: ['/usr/local/bin/sing-box', '/usr/bin/sing-box', '/etc/sing-box', '/usr/local/etc/sing-box', '/var/lib/sing-box', '/etc/s-box', '/root/sbox'], pkgs: ['sing-box'] },
  { id: 'hysteria', name: 'Hysteria / Hysteria2', units: ['hysteria-server', 'hysteria-server@*', 'hysteria', 'hysteria2'], paths: ['/usr/local/bin/hysteria', '/etc/hysteria', '/etc/hysteria2'] },
  { id: 'tuic', name: 'TUIC', units: ['tuic', 'tuic-server'], paths: ['/usr/local/bin/tuic', '/usr/local/bin/tuic-server', '/etc/tuic', '/opt/tuic', '/root/tuic'] },
  { id: 'trojan', name: 'Trojan / Trojan-Go', units: ['trojan-go', 'trojan'], paths: ['/usr/local/bin/trojan-go', '/usr/local/etc/trojan-go', '/etc/trojan-go', '/usr/local/bin/trojan', '/usr/local/etc/trojan'] },
  { id: 'ss-rust', name: 'shadowsocks-rust', units: ['shadowsocks-rust', 'ssserver', 'shadowsocks'], paths: ['/usr/local/bin/ssserver', '/usr/local/bin/sslocal', '/etc/shadowsocks-rust', '/etc/shadowsocks'] },
  { id: 'ss-libev', name: 'shadowsocks-libev', units: ['shadowsocks-libev', 'shadowsocks-libev-server@*'], paths: ['/etc/shadowsocks-libev'], pkgs: ['shadowsocks-libev'] },
  { id: 'gost', name: 'GOST 转发', units: ['gost'], paths: ['/usr/local/bin/gost', '/etc/gost'] },
  { id: 'realm', name: 'Realm 转发', units: ['realm'], paths: ['/usr/local/bin/realm', '/etc/realm', '/root/realm'] },
  { id: 'brook', name: 'Brook', units: ['brook'], paths: ['/usr/local/bin/brook', '/etc/brook'] },
  {
    id: 'bt', name: '宝塔面板', units: ['bt', 'btpanel'], markers: ['/www/server'], detect: ['/www/server/panel', '/etc/init.d/bt'],
    paths: ['/www', '/usr/bin/bt', '/etc/init.d/bt'], extraPaths: `grep -l '/www/server' /etc/my.cnf 2>/dev/null`,
    danger: '连同它装的 Nginx / MySQL / PHP 等，以及 /www 下的网站文件、数据库、宝塔备份一起删除',
  },
  {
    id: '1panel', name: '1Panel', units: ['1panel', '1panel-core', '1panel-agent'],
    paths: ['/usr/local/bin/1panel', '/usr/local/bin/1pctl', '/usr/local/bin/1panel-core', '/usr/local/bin/1panel-agent', '/usr/bin/1panel', '/usr/bin/1pctl', '/opt/1panel'],
    extraPaths: `B=$(sed -n 's/^BASE_DIR=//p' /usr/local/bin/1pctl /usr/bin/1pctl 2>/dev/null | head -1 | tr -d "\\"' "); [ -n "$B" ] && [ -d "$B/1panel" ] && echo "$B/1panel"`,
    pre: `if command -v docker >/dev/null; then for c in $(docker ps -aq --filter label=createdBy=1Panel 2>/dev/null); do docker rm -f -v "$c" >/dev/null 2>&1 && echo "  删除 1Panel 应用容器 $c"; done; docker network rm 1panel-network >/dev/null 2>&1; fi`,
    danger: '连同 1Panel 装的应用（Docker 容器）和网站数据一起删除；应用容器不会备份',
  },
  {
    id: 'hiddify', name: 'Hiddify Manager', units: ['hiddify-*'], markers: ['/opt/hiddify-manager'],
    paths: ['/opt/hiddify-manager', '/opt/hiddify-config', '/opt/hiddify-server'],
    danger: '它装的 Nginx、HAProxy、MariaDB、Redis 等系统软件包保留（别的程序可能也在用），它自己的服务和目录全部删除',
  },
];
// 不当作「其他程序」的系统 / 自己的进程
const SYSTEM_PROCS = /^(sshd|systemd|systemd-resolve|systemd-network|systemd-timesyn|chronyd|ntpd|dhclient|dhcpcd|rpcbind|nodedeck-agent|nodedeck-sing|docker-proxy|dockerd|containerd|master|exim4|postfix|cupsd|avahi-daemon|qemu-ga|cloud-init|snapd)$/;
const BACKUP_ROOT = '/root/nodedeck-backup';

function unitFileFn() {
  return [
    `unit_files() { for d in /etc/systemd/system /usr/lib/systemd/system /lib/systemd/system; do for f in "$d"/$1.service; do [ -f "$f" ] && echo "$f"; done; done; [ -f "/etc/init.d/$1" ] && echo "/etc/init.d/$1"; return 0; }`,
    // 内容里引用了某个目录的服务文件（宝塔装的 nginx / mysqld 等）
    `marker_units() { for f in /etc/systemd/system/*.service /usr/lib/systemd/system/*.service /lib/systemd/system/*.service /etc/init.d/*; do [ -f "$f" ] && grep -qs "$1" "$f" && echo "$f"; done; return 0; }`,
  ].join('\n');
}

async function scanOthers(server) {
  return withSSH(server, async (ssh) => {
    const lines = [unitFileFn()];
    for (const a of OTHER_APPS) {
      for (const u of a.units) lines.push(`for f in $(unit_files '${u}'); do n=$(basename "$f" .service); st=$( (systemctl is-active "$n" 2>/dev/null || rc-service "$n" status 2>/dev/null | grep -q started && echo active) | head -1); echo "U|${a.id}|$n|$st|$f"; done`);
      for (const p of a.detect || a.paths) lines.push(`[ -e ${shq(p)} ] && echo "D|${a.id}|${p}"`);
      for (const p of a.paths) lines.push(`[ -e ${shq(p)} ] && echo "P|${a.id}|${p}|$(du -sm ${shq(p)} 2>/dev/null | cut -f1)"`);
    }
    lines.push(`echo "---LISTEN"; (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null | tail -n +3)`);
    lines.push(`echo "---PIDS"; for p in $( (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null) | grep -o 'pid=[0-9]*\\|[0-9]*/' | tr -dc '0-9\\n' | sort -u); do [ -d /proc/$p ] || continue; echo "I|$p|$(readlink /proc/$p/exe 2>/dev/null)|$(grep -o '[^/]*\\.service' /proc/$p/cgroup 2>/dev/null | head -1)|$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null | cut -c1-120)"; done`);
    // 备份：新格式（可恢复）和旧版留下的压缩包
    lines.push(`for d in ${BACKUP_ROOT}/*/; do [ -f "$d/meta.json" ] && echo "K|$(basename "$d")|$(du -sk "$d" | cut -f1)|$(tr -d '\\n' < "$d/meta.json")"; done; for f in /root/nodedeck-cleanup-*.tar.gz; do [ -f "$f" ] && echo "B|$f|$(du -k "$f" | cut -f1)"; done`);
    lines.push(`echo "---DOCKER"; command -v docker >/dev/null && docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null`);
    lines.push('true');
    const out = (await ssh.exec(lines.join('\n'), { timeout: 90000 })).stdout;
    const [head, rest1 = ''] = out.split('---LISTEN');
    const [listen, rest2 = ''] = rest1.split('---PIDS');
    const [pidsTxt, dockerTxt = ''] = rest2.split('---DOCKER');
    const procs = {};
    for (const l of pidsTxt.split('\n')) { const f = l.split('|'); if (f[0] === 'I') procs[f[1]] = { pid: f[1], exe: f[2] || '', unit: (f[3] || '').replace(/\.service$/, ''), cmd: (f[4] || '').trim() }; }
    // 监听端口：只看对外的（不含 127.0.0.1 / ::1）
    const ports = [];
    for (const l of listen.split('\n')) {
      const t = l.trim().split(/\s+/);
      if (t.length < 5) continue;
      const proto = /^udp/i.test(t[0]) ? 'udp' : 'tcp';
      const local = t.find((x, i) => i >= 3 && /:\d+$/.test(x)) || '';
      const m = local.match(/^(.*):(\d+)$/);
      if (!m || /^(127\.|\[?::1\]?|localhost)/.test(m[1])) continue;
      const pid = (l.match(/pid=(\d+)/) || l.match(/\s(\d+)\/\S+/) || [])[1];
      const pname = (l.match(/\(\("([^"]+)"/) || l.match(/\s\d+\/(\S+)/) || [])[1] || '';
      ports.push({ proto, port: Number(m[2]), pid, pname });
    }
    const portsOf = (pred) => [...new Set(ports.filter((p) => p.pid && procs[p.pid] && pred(procs[p.pid], p)).map((p) => `${p.port}/${p.proto}`))];
    const apps = [];
    for (const a of OTHER_APPS) {
      const units = []; const paths = []; let found = false;
      for (const l of head.split('\n')) {
        const f = l.split('|');
        if (f[1] !== a.id) continue;
        if (f[0] === 'U' && !units.some((u) => u.name === f[2])) units.push({ name: f[2], active: f[3] === 'active', file: f[4] });
        if (f[0] === 'D') found = true;
        if (f[0] === 'P') paths.push({ path: f[2], mb: Number(f[3]) || 0 });
      }
      if (!units.length && !found) continue;
      const unitNames = units.map((u) => u.name);
      const p = portsOf((pr) => unitNames.includes(pr.unit) || a.paths.some((x) => pr.exe && (pr.exe === x || pr.exe.startsWith(x + '/'))) || (a.markers || []).some((m) => pr.exe.startsWith(m + '/')));
      apps.push({ kind: 'app', id: a.id, name: a.name, danger: a.danger || '', units, paths, ports: p, running: units.some((u) => u.active) || p.length > 0, mb: paths.reduce((x, y) => x + y.mb, 0) });
    }
    const known = new Set(apps.flatMap((a) => a.units.map((u) => u.name)));
    const knownExe = (exe) => OTHER_APPS.some((a) => a.paths.concat(a.markers || []).some((x) => exe === x || exe.startsWith(x + '/')));
    const containers = dockerTxt.split('\n').map((l) => l.split('|')).filter((f) => f.length >= 4 && /^[0-9a-f]{6,}$/.test(f[0])).map((f) => ({ kind: 'docker', id: f[0], name: f[1], image: f[2], status: f[3], ports: f[4] || '', running: /^Up/i.test(f[3]) }));
    const others = new Map();
    for (const p of ports) {
      const pr = p.pid && procs[p.pid];
      const name = (pr && (pr.exe.split('/').pop() || p.pname)) || p.pname;
      if (!pr || SYSTEM_PROCS.test(p.pname) || SYSTEM_PROCS.test(name) || /nodedeck/.test(pr.exe + pr.unit) || pr.exe === SB_BIN) continue;
      if ((pr.unit && known.has(pr.unit)) || knownExe(pr.exe)) continue;
      if (/^(docker|containerd)/.test(pr.unit)) continue;
      const key = pr.unit || pr.exe || name;
      const o = others.get(key) || { kind: 'other', id: key, unit: pr.unit, exe: pr.exe, cmd: pr.cmd, name, ports: [] };
      const pp = `${p.port}/${p.proto}`;
      if (!o.ports.includes(pp)) o.ports.push(pp);
      others.set(key, o);
    }
    const backups = [];
    for (const l of out.split('\n')) {
      const f = l.split('|');
      if (f[0] === 'K' && /^\d{12,14}$/.test(f[1])) { let meta = {}; try { meta = JSON.parse(f.slice(3).join('|')); } catch (_) { /* ignore */ } backups.push({ id: f[1], kb: Number(f[2]) || 0, ...meta }); }
    }
    const oldBackups = out.split('\n').map((l) => l.split('|')).filter((f) => f[0] === 'B' && /^\/root\/nodedeck-cleanup-\d+\.tar\.gz$/.test(f[1])).map((f) => ({ path: f[1], kb: Number(f[2]) || 0 }));
    return { apps, containers, others: [...others.values()], backups: backups.sort((x, y) => (y.at || 0) - (x.at || 0)), oldBackups, at: Date.now() };
  });
}

function streamLog(log) {
  let buf = '';
  return { onData: (t) => { buf += t; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) log(line); } }, flush: () => { if (buf.trim()) log(buf.trim()); buf = ''; } };
}

// 删除选中的：items = [{ kind:'app', id } | { kind:'docker', id, image } | { kind:'other', unit } | { kind:'oldBackups' }]
// backup=true 时先把要删的程序整套打包，之后可以一键恢复
async function cleanOthers(server, items, log = () => {}, { backup: doBackup = false } = {}) {
  return withSSH(server, async (ssh) => {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const BK = `${BACKUP_ROOT}/${ts}`;
    const apps = items.filter((it) => it.kind === 'app').map((it) => OTHER_APPS.find((x) => x.id === it.id)).filter(Boolean);
    const sh = [unitFileFn(), 'set +e',
      'T=$(mktemp -d); : > $T/units; : > $T/paths',
      // 记下服务：名字|文件
      `note_unit() { n=$(basename "$1" .service); grep -qx "$n|$1" $T/units || echo "$n|$1" >> $T/units; }`,
      `stop_unit() { n="$1"; f="$2"; echo "  停止服务 $n"; case "$f" in /etc/init.d/*) "$f" stop >/dev/null 2>&1; update-rc.d -f "$n" remove >/dev/null 2>&1; chkconfig --del "$n" >/dev/null 2>&1; rc-update del "$n" >/dev/null 2>&1;; *) systemctl stop "$n" >/dev/null 2>&1; systemctl disable "$n" >/dev/null 2>&1;; esac; }`,
      `owned() { dpkg -S "$1" >/dev/null 2>&1 || rpm -qf "$1" >/dev/null 2>&1 || apk info -W "$1" >/dev/null 2>&1; }`,
      `safe_path() { case "$1" in /www|/usr/?*/?*|/usr/local/?*|/etc/?*|/opt/?*|/var/?*/?*|/root/?*|/www/?*) case "$1" in *nodedeck*|*..*) return 1;; esac; return 0;; esac; return 1; }`,
    ];
    // 第一步：找出每个程序的服务和路径
    const cronPats = [];
    sh.push(': > $T/bkonly');
    for (const a of apps) {
      sh.push(`echo "▶ ${a.name}"`);
      for (const u of a.units) sh.push(`for f in $(unit_files '${u}'); do note_unit "$f"; done`);
      for (const m of a.markers || []) sh.push(`for f in $(marker_units ${shq(m)}); do note_unit "$f"; done`);
      for (const p of a.paths) sh.push(`[ -e ${shq(p)} ] && echo ${shq(p)} >> $T/paths`);
      if (a.extraPaths) sh.push(`for p in $(${a.extraPaths}); do safe_path "$p" && [ -e "$p" ] && echo "$p" >> $T/paths; done`);
      cronPats.push(...a.paths.filter((x) => x !== '/www'), ...(a.markers || []));
    }
    const dockerItems = items.filter((it) => it.kind === 'docker' && /^[0-9a-f]{6,64}$/.test(it.id));
    const with1p = apps.some((a) => a.id === '1panel');
    const backingUp = doBackup && (apps.length || dockerItems.length);
    // 第二步（可选）：容器备份要在停服务、删容器之前做：配置（docker inspect）、数据卷、挂载目录、本地镜像
    if (backingUp && (dockerItems.length || with1p)) {
      sh.push(`mkdir -p ${BK}/docker && chmod 700 ${BACKUP_ROOT} ${BK}`,
        `bk_ctr() { c="$1"; n=$(docker inspect -f '{{.Name}}' "$c" 2>/dev/null | tr -d '/'); [ -n "$n" ] || return 0; docker inspect "$c" > ${BK}/docker/ctr-$n.json; echo "  备份容器 $n"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$c"); do [ -f ${BK}/docker/vol-$v.tar.gz ] || { mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null); [ -n "$mp" ] && tar czf ${BK}/docker/vol-$v.tar.gz -C "$mp" . 2>/dev/null && echo "    数据卷 $v"; }; done
  for b in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} {{end}}{{end}}' "$c"); do [ -d "$b" ] && safe_path "$b" && echo "$b" >> $T/bkonly; done
  wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c" 2>/dev/null); case "$wd" in /*) safe_path "$wd" && echo "$wd" >> $T/bkonly;; esac
  img=$(docker inspect -f '{{.Config.Image}}' "$c"); if [ "$(docker image inspect -f '{{len .RepoDigests}}' "$img" 2>/dev/null)" = "0" ]; then f=${BK}/docker/img-$(printf %s "$img" | tr -c 'A-Za-z0-9._-' '_').tar.gz; [ -f "$f" ] || { docker save "$img" | gzip > "$f" && echo "    本地镜像 $img"; }; fi; }`);
      for (const it of dockerItems) sh.push(`bk_ctr ${it.id}`);
      if (with1p) sh.push(`for c in $(docker ps -aq --filter label=createdBy=1Panel 2>/dev/null); do bk_ctr "$c"; done`);
    }
    // 停服务、做删除前的准备
    if (apps.length) sh.push(`while IFS='|' read -r n f; do [ -n "$n" ] && stop_unit "$n" "$f"; done < $T/units`);
    for (const a of apps) if (a.pre) sh.push(a.pre);
    // 第三步（可选）：程序整套打包
    if (backingUp) {
      const portsOf = (it) => (it.ports || []).filter((x) => /^\d{1,5}\/(tcp|udp)$/.test(x));
      const meta = {
        at: Date.now(), host: server.host,
        apps: apps.map((a) => ({ id: a.id, name: a.name, ports: portsOf(items.find((it) => it.kind === 'app' && it.id === a.id) || {}) })),
        containers: dockerItems.map((it) => String(it.name || it.id).replace(/[^\w.-]/g, '')).concat(with1p ? ['1Panel 的应用容器'] : []),
      };
      sh.push(`mkdir -p ${BK} && chmod 700 ${BACKUP_ROOT} ${BK}`,
        `{ cut -d'|' -f2 $T/units; cat $T/paths $T/bkonly; } | grep -v '^$' | sort -u | sed 's#^/##' > $T/list`,
        `echo "  打包备份（程序、配置、服务文件、数据目录）…"; if [ -s $T/list ]; then tar czf ${BK}/files.tar.gz -C / -T $T/list 2>/dev/null; else tar czf ${BK}/files.tar.gz -T /dev/null; fi; cp $T/units ${BK}/units.txt`,
        cronPats.length ? `crontab -l 2>/dev/null | grep -F ${[...new Set(cronPats)].map((x) => '-e ' + shq(x)).join(' ')} > ${BK}/cron.txt` : `: > ${BK}/cron.txt`,
        `printf '%s' ${shq(JSON.stringify(meta))} > ${BK}/meta.json`,
        `[ -f ${BK}/files.tar.gz ] && echo "备份完成：${BK}（$(du -sh ${BK} | cut -f1)），可以在 NodeDeck 里一键恢复" || echo "⚠ 备份失败"`);
    }
    // 第三步：删除服务文件、路径、软件包、定时任务
    if (apps.length) {
      sh.push(`while IFS='|' read -r n f; do [ -f "$f" ] || continue; if owned "$f"; then echo "  服务文件属于系统软件包，保留：$f"; else rm -f "$f" && echo "  删除服务文件 $f"; fi; done < $T/units`);
      sh.push(`sort -u $T/paths | while read -r p; do safe_path "$p" && [ -e "$p" ] && rm -rf "$p" && echo "  删除 $p"; done`);
      for (const a of apps) for (const pk of a.pkgs || []) sh.push(`if dpkg -s ${shq(pk)} >/dev/null 2>&1; then echo "  卸载软件包 ${pk}"; DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq ${shq(pk)} >/dev/null 2>&1; elif rpm -q ${shq(pk)} >/dev/null 2>&1; then yum remove -y -q ${shq(pk)} >/dev/null 2>&1; elif apk info -e ${shq(pk)} >/dev/null 2>&1; then apk del -q ${shq(pk)} >/dev/null 2>&1; fi`);
      if (cronPats.length) sh.push(`if crontab -l >$T/cron 2>/dev/null; then grep -v -F ${[...new Set(cronPats)].map((x) => '-e ' + shq(x)).join(' ')} $T/cron > $T/cron2; cmp -s $T/cron $T/cron2 || { crontab $T/cron2 && echo "  已清理相关的定时任务"; }; fi`);
    }
    for (const it of items) {
      if (it.kind === 'oldBackups') {
        sh.push('echo "▶ 删除旧版留下的备份"; for f in /root/nodedeck-cleanup-*.tar.gz; do [ -f "$f" ] && rm -f "$f" && echo "  删除 $f"; done');
      } else if (it.kind === 'docker' && /^[0-9a-f]{6,64}$/.test(it.id)) {
        const img = /^[\w./:@-]+$/.test(it.image || '') ? it.image : '';
        // 先记下它用的命名数据卷，删容器后没有别的容器在用就一起删
        sh.push(`echo "▶ 删除 Docker 容器 ${String(it.name || it.id).replace(/[^\w.-]/g, '')}"; vols=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' ${it.id} 2>/dev/null); docker rm -f -v ${it.id} >/dev/null 2>&1 && echo "  已删除容器" || echo "  删除失败"; for v in $vols; do docker volume rm "$v" >/dev/null 2>&1 && echo "  已删除数据卷 $v"; done${img ? `; docker image rm ${shq(img)} >/dev/null 2>&1 && echo "  已删除镜像 ${img}"` : ''}`);
      } else if (it.kind === 'other' && /^[\w@.:-]+$/.test(it.unit || '') && !/nodedeck|ssh|systemd|docker|containerd/.test(it.unit)) {
        sh.push(`echo "▶ 停用服务 ${it.unit}"; for f in $(unit_files ${shq(it.unit)}); do stop_unit ${shq(it.unit)} "$f"; done`);
      }
    }
    sh.push('rm -rf $T; systemctl daemon-reload >/dev/null 2>&1; systemctl reset-failed >/dev/null 2>&1; echo "完成"');
    const st = streamLog(log);
    const r = await ssh.exec(sh.join('\n'), { timeout: 1200000, onData: st.onData });
    st.flush();
    return { backup: /备份完成/.test(r.stdout) ? BK : '', output: r.stdout };
  }, { log });
}

// 恢复前读取备份内容和 VPS 当前占用的端口（用来提前解决端口冲突）
async function backupInfo(server, id) {
  if (!/^\d{12,14}$/.test(String(id))) throw new Error('备份编号不对');
  const BK = `${BACKUP_ROOT}/${id}`;
  return withSSH(server, async (ssh) => {
    const r = await ssh.exec(`cat ${BK}/meta.json 2>/dev/null; echo; echo "---CTR"; for f in ${BK}/docker/ctr-*.json; do [ -f "$f" ] && { cat "$f"; echo "---SEP"; }; done; echo "---LISTEN"; (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null | tail -n +3); echo "---DOCKER"; command -v docker >/dev/null && echo yes`, { timeout: 60000 });
    const [metaTxt, rest = ''] = r.stdout.split('---CTR');
    const [ctrTxt, rest2 = ''] = rest.split('---LISTEN');
    const [listen, dockerTxt = ''] = rest2.split('---DOCKER');
    let meta = {};
    try { meta = JSON.parse(metaTxt.trim()); } catch (_) { throw new Error('读不到这份备份的信息，可能已经被删了'); }
    const containers = [];
    for (const part of ctrTxt.split('---SEP')) { try { const j = JSON.parse(part.trim()); if (Array.isArray(j) && j[0]) containers.push(j[0]); } catch (_) { /* ignore */ } }
    const busy = [];
    for (const l of listen.split('\n')) {
      const t = l.trim().split(/\s+/);
      if (t.length < 5) continue;
      const local = t.find((x, i) => i >= 3 && /:\d+$/.test(x)) || '';
      const m = local.match(/:(\d+)$/);
      if (!m) continue;
      const pname = (l.match(/\(\("([^"]+)"/) || l.match(/\s\d+\/(\S+)/) || [])[1] || '';
      busy.push({ port: Number(m[1]), proto: /^udp/i.test(t[0]) ? 'udp' : 'tcp', pname });
    }
    return { meta, containers, busy, docker: /yes/.test(dockerTxt) };
  });
}

// 按 docker inspect 的结果重新生成 docker run（remap：{ '主机端口/协议': 新端口 }）
function dockerRunCmd(ins, remap = {}) {
  const c = ins.Config || {}; const hc = ins.HostConfig || {};
  const a = ['docker run -d', '--name ' + shq(String(ins.Name || '').replace(/^\//, ''))];
  const rp = hc.RestartPolicy || {};
  if (rp.Name && rp.Name !== 'no') a.push('--restart ' + (rp.Name === 'on-failure' && rp.MaximumRetryCount ? `on-failure:${rp.MaximumRetryCount}` : rp.Name));
  const net = hc.NetworkMode;
  if (net && !['default', 'bridge'].includes(net)) a.push('--network ' + shq(net));
  if (net !== 'host') {
    for (const [cp, binds] of Object.entries(hc.PortBindings || {})) {
      const proto = cp.split('/')[1] || 'tcp';
      for (const b of binds || []) {
        const hp = remap[`${b.HostPort}/${proto}`] || b.HostPort;
        const ip = b.HostIp && b.HostIp !== '0.0.0.0' && b.HostIp !== '::' ? (b.HostIp.includes(':') ? `[${b.HostIp}]:` : `${b.HostIp}:`) : '';
        a.push('-p ' + shq(`${ip}${hp ? hp + ':' : ''}${cp}`));
      }
    }
  }
  for (const e of c.Env || []) a.push('-e ' + shq(e));
  for (const m of ins.Mounts || []) {
    const ro = m.RW === false ? ':ro' : '';
    if (m.Type === 'volume' && m.Name) a.push('-v ' + shq(`${m.Name}:${m.Destination}${ro}`));
    else if (m.Type === 'bind') a.push('-v ' + shq(`${m.Source}:${m.Destination}${ro}`));
  }
  if (hc.Privileged) a.push('--privileged');
  for (const x of hc.CapAdd || []) a.push('--cap-add ' + shq(x));
  for (const d of hc.Devices || []) a.push('--device ' + shq(`${d.PathOnHost}:${d.PathInContainer}`));
  for (const x of hc.ExtraHosts || []) a.push('--add-host ' + shq(x));
  for (const [k, v] of Object.entries(c.Labels || {})) if (!k.startsWith('com.docker.compose')) a.push('--label ' + shq(`${k}=${v}`));
  if (c.WorkingDir) a.push('-w ' + shq(c.WorkingDir));
  if (c.User) a.push('-u ' + shq(c.User));
  const ep = c.Entrypoint || [];
  let cmd = c.Cmd || [];
  if (ep.length) { a.push('--entrypoint ' + shq(ep[0])); cmd = [...ep.slice(1), ...cmd]; }
  a.push(shq(c.Image));
  for (const x of cmd) a.push(shq(x));
  return a.join(' ');
}

// 一键恢复：解压回原位置、恢复定时任务、重新启用并启动服务；容器按备份重新创建（端口冲突的按 remap 换端口）
async function restoreBackup(server, id, log = () => {}, { containers = [], remap = {} } = {}) {
  if (!/^\d{12,14}$/.test(String(id))) throw new Error('备份编号不对');
  const BK = `${BACKUP_ROOT}/${id}`;
  return withSSH(server, async (ssh) => {
    const sh = ['set +e',
      `[ -f ${BK}/files.tar.gz ] || { echo "找不到备份文件"; exit 1; }`,
      `echo "▶ 解压程序、配置和数据到原来的位置…"; tar xzf ${BK}/files.tar.gz -C / && echo "  完成"`,
      `if [ -s ${BK}/cron.txt ]; then T=$(mktemp); crontab -l 2>/dev/null > $T; while IFS= read -r l; do grep -qxF "$l" $T || echo "$l" >> $T; done < ${BK}/cron.txt; crontab $T && echo "  定时任务已恢复"; rm -f $T; fi`,
      'systemctl daemon-reload >/dev/null 2>&1',
      `[ -f ${BK}/units.txt ] && while IFS='|' read -r n f; do [ -n "$n" ] || continue; case "$f" in /etc/init.d/*) (update-rc.d "$n" defaults >/dev/null 2>&1 || chkconfig --add "$n" >/dev/null 2>&1 || rc-update add "$n" default >/dev/null 2>&1); "$f" start >/dev/null 2>&1;; *) systemctl enable "$n" >/dev/null 2>&1; systemctl start "$n" >/dev/null 2>&1;; esac; echo "  启动服务 $n"; done < ${BK}/units.txt`,
    ];
    if (containers.length) {
      sh.push('echo "▶ 恢复 Docker 容器"',
        // 没有 Docker 就先装上（官方安装脚本）
        `if ! command -v docker >/dev/null; then echo "  VPS 上没有 Docker，正在安装（官方脚本，约 1–3 分钟）…"; curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || wget -qO- https://get.docker.com | sh >/dev/null 2>&1; systemctl enable --now docker >/dev/null 2>&1; command -v docker >/dev/null && echo "  Docker 已安装" || { echo "  ✗ Docker 安装失败，容器没法恢复"; exit 2; }; fi`,
        `for f in ${BK}/docker/img-*.tar.gz; do [ -f "$f" ] && gunzip -c "$f" | docker load >/dev/null 2>&1 && echo "  导入本地镜像 $(basename "$f")"; done`,
        `for f in ${BK}/docker/vol-*.tar.gz; do [ -f "$f" ] || continue; v=$(basename "$f" .tar.gz); v=\${v#vol-}; docker volume create "$v" >/dev/null 2>&1; mp=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null); [ -n "$mp" ] && tar xzf "$f" -C "$mp" && echo "  数据卷 $v"; done`);
      const projects = new Set();
      for (const ins of containers) {
        const name = String(ins.Name || '').replace(/^\//, '').replace(/[^\w.-]/g, '');
        const wd = ins.Config?.Labels?.['com.docker.compose.project.working_dir'];
        if (wd && /^\/[\w./@-]+$/.test(wd)) {
          // docker compose 部署的：用原来的项目目录整体拉起（目录已经随备份恢复）
          if (projects.has(wd)) continue;
          projects.add(wd);
          sh.push(`if [ -d ${shq(wd)} ]; then cd ${shq(wd)} && { docker compose up -d >/dev/null 2>&1 || docker-compose up -d >/dev/null 2>&1; } && echo "  compose 项目 ${wd} 已启动" || echo "  ✗ compose 项目 ${wd} 启动失败"; cd /; fi`);
          continue;
        }
        const net = ins.HostConfig?.NetworkMode;
        if (net && !['default', 'bridge', 'host', 'none'].includes(net) && !/^container:/.test(net)) sh.push(`docker network inspect ${shq(net)} >/dev/null 2>&1 || docker network create ${shq(net)} >/dev/null 2>&1`);
        const img = ins.Config?.Image || '';
        sh.push(`docker image inspect ${shq(img)} >/dev/null 2>&1 || { echo "  下载镜像 ${img.replace(/[^\w./:@-]/g, '')} …"; docker pull ${shq(img)} >/dev/null 2>&1; }`,
          `docker rm -f ${shq(name)} >/dev/null 2>&1; ${dockerRunCmd(ins, remap)} >/dev/null 2>&1 && echo "  容器 ${name} 已启动" || echo "  ✗ 容器 ${name} 启动失败"`);
      }
    }
    sh.push('echo "恢复完成"');
    const st = streamLog(log);
    const r = await ssh.exec(sh.join('\n'), { timeout: 1800000, onData: st.onData });
    st.flush();
    if (r.code !== 0 && !/恢复完成/.test(r.stdout)) throw new Error((r.stdout + r.stderr).trim().split('\n').pop() || '恢复失败');
    return true;
  }, { log });
}

async function deleteBackup(server, id) {
  if (!/^\d{12,14}$/.test(String(id))) throw new Error('备份编号不对');
  return withSSH(server, (ssh) => ssh.run(`rm -rf ${BACKUP_ROOT}/${id}; rmdir ${BACKUP_ROOT} 2>/dev/null; true`));
}

// BBR 和 CUBIC 对比：交替切换拥塞控制，各测几轮下载速度（由调用方测），最后恢复原来的设置

module.exports = { OTHER_APPS, scanOthers, cleanOthers, backupInfo, dockerRunCmd, restoreBackup, deleteBackup };
