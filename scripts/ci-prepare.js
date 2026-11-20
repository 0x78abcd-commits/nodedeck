// CI 用：把版本号和发布仓库写进 package.json（这样你不用手动改）
const fs = require('fs');
const [version, repository] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+/.test(version || '')) { console.error('版本号格式应为 x.y.z，收到：' + version); process.exit(1); }
const [owner, repo] = (repository || '').split('/');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = version;
pkg.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }];
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(`version=${version} publish=${owner}/${repo}`);
