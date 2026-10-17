#!/usr/bin/env node
/* ============================================================
 * 网页端探针统一入口
 * ------------------------------------------------------------
 * 做三件事：
 *   ① 生成一份「时间戳刷成当前」的数据样本到 tests/.tmp/fixture.json
 *      —— 直接用 data/slurm.json 会过期：超过 3 小时页面会（正确地）显示
 *         「服务器离线」条幅，把首个标题下推 60~100px，布局类断言会假失败。
 *   ② 起一个静态服务器（默认随机空闲端口）指向仓库根
 *   ③ 依次执行 tests/web/*.js 探针，注入 BASE_URL / FIXTURE，汇总结果
 *
 * 用法：
 *   npm install            # 首次：装 playwright
 *   npx playwright install chromium
 *   npm test               # 跑全部
 *   npm test -- --fast     # 只跑快探针（跳过含真·30 秒等待的两个）
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const FIXTURE = path.join(TMP, 'fixture.json');

// 含真·等待（30 秒自动收起 / 多档窗口逐项点击）的慢探针
const SLOW = ['probe_applog.js', 'probe_nav_reach.js'];
const ORDER = [
  'probe_header_state.js',
  'probe_nav_hilite.js',
  'probe_apksize.js',
  'probe_publish.js',
  'probe_applog_nav.js',
  'probe_cards.js',
  'probe_refresh.js',
  'probe_applog.js',
  'probe_nav_reach.js'
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive', '.jpg': 'image/jpeg'
};

function pad(n) { return (n < 10 ? '0' : '') + n; }
function nowSlurm() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T'
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.000000';
}

function buildFixture() {
  fs.mkdirSync(TMP, { recursive: true });
  const src = path.join(ROOT, 'data', 'slurm.json');
  if (!fs.existsSync(src)) {
    console.error('!! 缺少 data/slurm.json，无法生成测试样本');
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(src, 'utf8'));
  const t = nowSlurm();
  d.timestamp = Object.assign({}, d.timestamp, { collected_at: t });
  d.last_updated = t.replace('T', ' ').slice(0, 19);
  if (d.overview) d.overview.last_updated = d.last_updated;
  fs.writeFileSync(FIXTURE, JSON.stringify(d));
  return t;
}

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function runProbe(file, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'web', file)], {
      env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', b => { out += b.toString(); });
    child.stderr.on('data', b => { out += b.toString(); });
    child.on('close', code => {
      const failLines = out.split('\n').filter(l => /\[FAIL\]/.test(l));
      const passCount = (out.match(/\[OK\]/g) || []).length;
      resolve({ file, code, ms: Date.now() - t0, out, failLines, passCount });
    });
  });
}

(async () => {
  const fast = process.argv.includes('--fast');
  const stamp = buildFixture();
  const srv = await startServer();
  const port = srv.address().port;
  const BASE_URL = 'http://127.0.0.1:' + port;
  console.log('样本时间戳已刷成当前：' + stamp);
  console.log('静态服务：' + BASE_URL + '（根目录 = 仓库根）');
  console.log('模式：' + (fast ? '--fast（跳过慢探针）' : '全部'));
  console.log('');

  const list = ORDER.filter(f => fs.existsSync(path.join(__dirname, 'web', f)))
    .filter(f => !(fast && SLOW.indexOf(f) >= 0));
  const results = [];
  for (const f of list) {
    process.stdout.write('▶ ' + f + ' ... ');
    const r = await runProbe(f, { BASE_URL, FIXTURE });
    results.push(r);
    console.log((r.code === 0 ? '通过' : '失败') + '（' + r.passCount + ' 项 OK / ' + r.failLines.length + ' 项 FAIL，'
      + Math.round(r.ms / 1000) + 's）');
    if (r.code !== 0) r.failLines.forEach(l => console.log('    ' + l.trim()));
  }
  srv.close();

  const bad = results.filter(r => r.code !== 0);
  console.log('');
  console.log('===== 汇总：' + (results.length - bad.length) + '/' + results.length + ' 个探针通过，'
    + results.reduce((a, r) => a + r.passCount, 0) + ' 项断言 OK =====');
  if (bad.length) {
    console.log('失败：' + bad.map(r => r.file).join(', '));
    // 失败时把完整输出打出来，便于 CI 定位
    bad.forEach(r => { console.log('\n----- ' + r.file + ' 完整输出 -----'); console.log(r.out); });
  }
  process.exit(bad.length ? 1 : 0);
})();
