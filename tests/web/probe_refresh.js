// ⚠ 由 WorkBuddy 工作区迁入仓库时做过可移植化改造（2026-10-17）：
//   · 静态服务地址统一取 process.env.BASE_URL（由 tests/run-web.js 注入）
//   · 数据统一取 process.env.FIXTURE —— 该文件的时间戳已被刷成「当前」，
//     否则 data/slurm.json 超过 3 小时会（正确地）触发「服务器离线」条幅，
//     把首个标题下推 60~100px，导致布局类断言假失败。
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const ORIGIN = process.env.BASE_URL || 'http://127.0.0.1:8793';
const FIXTURE = process.env.FIXTURE || path.join(ROOT, 'data', 'slurm.json');
const APK_FILE = path.join(ROOT, 'download', 'PhyHPC-Monitor.apk');
const APP_VER = (() => {
  try { return JSON.parse(require('fs').readFileSync(path.join(ROOT, 'data', 'app_version.json'), 'utf8')); }
  catch (e) { return {}; }
})();
/* 网页端「刷新失败」误报治理 + 服务器离线横幅 验收
   场景一：并发请求 —— 早发请求迟到失败，晚发请求已成功 → 失败必须被丢弃
   场景二：连续失败迟滞 —— 单次失败静默，连续两次才提示「刷新失败」
   场景三：数据陈旧 —— collected_at 为 4 小时前 → 离线条幅 + 时间条改文案
   场景四：恢复正常 —— 数据回到新鲜 → 横幅消失、时间条复原 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = ORIGIN + '/';
const LOCAL_JSON = FIXTURE;
const base = JSON.parse(fs.readFileSync(LOCAL_JSON, 'utf-8'));

let pass = 0, fail = 0;
function check(n, ok, x) {
  console.log((ok ? '  [OK]  ' : '  [FAIL]') + ' ' + n + (x !== undefined ? '  → ' + x : ''));
  ok ? pass++ : fail++;
}
const pad = n => (n < 10 ? '0' : '') + n;
// 生成形如 2026-10-15T15:00:04.664360 的本地时间串
function stamp(msAgo) {
  const t = new Date(Date.now() - msAgo);
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + 'T' +
    pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '.000000';
}
function payload(msAgo) {
  const d = JSON.parse(JSON.stringify(base));
  const s = stamp(msAgo);
  d.timestamp = d.timestamp || {};
  d.timestamp.collected_at = s;
  d.overview = d.overview || {};
  d.overview.last_updated = s.slice(0, 10) + ' ' + s.slice(11, 19);
  return JSON.stringify(d, null, 2);
}

const STATE = () => ({
  dataWarn: window._dataWarn,
  failStreak: window._failStreak,
  seq: window._fetchSeq,
  offline: window.serverOffline,
  age: window.dataAgeText,
  bar: (document.getElementById('updateTime') || {}).textContent,
  barWarn: !!(document.getElementById('updateTime') || {}).classList &&
    document.getElementById('updateTime').classList.contains('badge-warn'),
  banner: !!document.getElementById('offlineBanner'),
  bannerText: document.getElementById('offlineBanner') ? document.getElementById('offlineBanner').textContent.trim() : ''
});

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  const netlog = [];
  page.on('console', m => {
    const t = m.text();
    if (/数据加载失败/.test(t)) netlog.push(t);
  });
  // 记录每次请求的最终结局（用于对齐时序）
  page.on('requestfailed', r => { if (/slurm\.json/.test(r.url())) netlog.push('  >> 请求失败: ' + (r.failure() || {}).errorText); });
  page.on('response', r => { if (/slurm\.json/.test(r.url())) netlog.push('  >> 响应 ' + r.status()); });

  // ---------- 场景一：并发请求，过期失败须被丢弃 ----------
  console.log('===== 场景一：并发 —— 早发请求迟到失败，晚发已成功 =====');
  let n1 = 0;
  await page.route('**/data/slurm.json', async route => {
    n1++;
    if (n1 === 1) {
      // 第 1 个请求：挂起 3 秒后再失败（模拟被中断的慢请求）
      await new Promise(r => setTimeout(r, 3000));
      await route.abort('failed').catch(() => {});
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: payload(0) });
    }
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);           // 首屏请求（=第 1 个）仍在挂起
  await page.evaluate(() => fetchData());   // 立即再发一次（=第 2 个），秒回成功
  await page.waitForTimeout(1200);

  let s = await page.evaluate(STATE);
  console.log('   第2个成功后: dataWarn=' + s.dataWarn + ' failStreak=' + s.failStreak + ' seq=' + s.seq);
  check('新请求成功 → 不处于刷新失败态', s.dataWarn === false, s.dataWarn);
  check('时间条显示正常文案', /最后更新/.test(s.bar || ''), s.bar);

  await page.waitForTimeout(2600);          // 等第 1 个请求的 abort 回调落地
  s = await page.evaluate(STATE);
  console.log('   过期失败落地后: dataWarn=' + s.dataWarn + ' failStreak=' + s.failStreak);
  check('过期失败被丢弃（failStreak 未被计入）', s.failStreak === 0, s.failStreak);
  check('过期失败未污染界面状态', s.dataWarn === false, s.dataWarn);
  check('时间条仍为正常文案（未出现「刷新失败」）', !/刷新失败/.test(s.bar || ''), s.bar);

  // ---------- 场景二：连续失败迟滞 ----------
  console.log('===== 场景二：连续失败才提示 =====');
  await page.unroute('**/data/slurm.json');
  await page.route('**/data/slurm.json', route => route.abort('failed'));

  await page.evaluate(() => fetchData());
  await page.waitForTimeout(700);
  s = await page.evaluate(STATE);
  console.log('   第1次失败: dataWarn=' + s.dataWarn + ' failStreak=' + s.failStreak + ' bar=' + s.bar);
  check('单次失败静默（不显示刷新失败）', s.dataWarn === false, s.dataWarn);
  check('单次失败不计入界面警告', !/刷新失败/.test(s.bar || ''), s.bar);
  check('失败计数为 1', s.failStreak === 1, s.failStreak);

  await page.evaluate(() => fetchData());
  await page.waitForTimeout(700);
  s = await page.evaluate(STATE);
  console.log('   第2次失败: dataWarn=' + s.dataWarn + ' failStreak=' + s.failStreak + ' bar=' + s.bar);
  check('连续两次失败 → 提示刷新失败', s.dataWarn === true, s.dataWarn);
  check('时间条出现「刷新失败」', /刷新失败/.test(s.bar || ''), s.bar);
  check('时间条进入警告配色', s.barWarn === true, s.barWarn);

  // 恢复成功 → 警告应立刻解除
  await page.unroute('**/data/slurm.json');
  await page.route('**/data/slurm.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: payload(0) }));
  console.log('   --- 改为成功源，触发一次请求 ---');
  const seqBefore = await page.evaluate(() => window._fetchSeq);
  await page.evaluate(() => fetchData());
  const seqAfter = await page.evaluate(() => window._fetchSeq);
  console.log('   seq: ' + seqBefore + ' → ' + seqAfter);
  await page.waitForTimeout(700);
  s = await page.evaluate(STATE);
  console.log('   恢复成功: dataWarn=' + s.dataWarn + ' failStreak=' + s.failStreak + ' seq=' + s.seq + ' bar=' + s.bar);
  console.log('   --- 网络事件 ---');
  netlog.slice(-8).forEach(l => console.log('     ' + l));
  check('恢复成功 → 警告解除', s.dataWarn === false, s.dataWarn);
  check('失败计数归零', s.failStreak === 0, s.failStreak);
  check('时间条复原为「最后更新」', /最后更新/.test(s.bar || '') && !/刷新失败/.test(s.bar || ''), s.bar);

  // ---------- 场景三：数据陈旧 → 服务器离线 ----------
  console.log('===== 场景三：数据 4 小时未更新 → 服务器离线 =====');
  await page.unroute('**/data/slurm.json');
  await page.route('**/data/slurm.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: payload(4 * 3600 * 1000 + 25 * 60000) }));

  await page.evaluate(() => fetchData());
  await page.waitForTimeout(900);
  s = await page.evaluate(STATE);
  console.log('   offline=' + s.offline + ' age="' + s.age + '"');
  console.log('   条幅: ' + s.bannerText);
  console.log('   时间条: ' + s.bar);
  check('判定为服务器离线', s.offline === true, s.offline);
  check('数据年龄文案为 4 小时 25 分', s.age === '4 小时 25 分', s.age);
  check('页面出现离线条幅', s.banner === true, s.banner);
  check('条幅文案含「服务器离线」', /服务器离线/.test(s.bannerText), s.bannerText);
  check('条幅文案含「未更新」与「采集」', /未更新/.test(s.bannerText) && /采集/.test(s.bannerText), '');
  check('时间条改为「数据已…未更新」', /数据已/.test(s.bar || '') && /未更新/.test(s.bar || ''), s.bar);
  check('时间条进入警告配色', s.barWarn === true, s.barWarn);

  // 横幅位置：应为 #app 的第一个子元素
  const firstIsBanner = await page.evaluate(() => {
    const app = document.getElementById('app');
    return app && app.firstElementChild && app.firstElementChild.id === 'offlineBanner';
  });
  check('条幅位于内容最前', firstIsBanner === true, firstIsBanner);

  // 横幅在五档宽度下不得造成横向溢出
  for (const w of [360, 420, 768, 1024, 1440]) {
    await page.setViewportSize({ width: w, height: 820 });
    await page.waitForTimeout(260);
    const ov = await page.evaluate(() => {
      const de = document.documentElement;
      const b = document.getElementById('offlineBanner');
      const cs = b ? getComputedStyle(b) : null;
      return {
        overflow: de.scrollWidth - de.clientWidth,
        h: b ? Math.round(b.getBoundingClientRect().height) : null,
        fs: cs ? cs.fontSize : null
      };
    });
    check('断点 ' + w + 'px：无横向溢出（溢出 ' + ov.overflow + 'px，高 ' + ov.h + 'px）',
      ov.overflow <= 1 && ov.h > 0, 'font=' + ov.fs);
  }

  // ---------- 场景四：数据恢复新鲜 → 横幅消失 ----------
  console.log('===== 场景四：数据恢复新鲜 → 横幅消失 =====');
  await page.unroute('**/data/slurm.json');
  await page.route('**/data/slurm.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: payload(2 * 60000) }));

  await page.evaluate(() => fetchData());
  await page.waitForTimeout(900);
  s = await page.evaluate(STATE);
  console.log('   offline=' + s.offline + ' banner=' + s.banner + ' bar=' + s.bar);
  check('离线状态解除', s.offline === false, s.offline);
  check('离线条幅已移除', s.banner === false, s.banner);
  check('时间条复原', /最后更新/.test(s.bar || ''), s.bar);

  console.log('===== 页面 JS 报错 =====');
  console.log('   错误数: ' + errs.length + (errs.length ? ' | ' + errs.slice(0, 2).join(' | ') : ''));

  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
