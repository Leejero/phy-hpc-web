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
/* APK 体积显示验收：动态读取 + 十进制口径 + 取不到时的静态兜底
   用法：与 python -m http.server 8793（root=_public-repo-tmp）同一条命令内启停 */
const { chromium } = require('playwright');
const fs = require('fs');
// ORIGIN 见文件头
const APK = APK_FILE;

let pass = 0, fail = 0;
const check = (n, ok, x) => {
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + n + (x !== undefined ? '  → ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await chromium.launch();
  const realSize = fs.statSync(APK).size;
  console.log('本地 APK 实际字节数: ' + realSize + '（十进制 %.4f MB）'.replace('%.4f', (realSize / 1e6).toFixed(4)));

  async function open(opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (opts.breakHead) {
      await ctx.route('**/download/PhyHPC-Monitor.apk', r => {
        if (r.request().method() === 'HEAD') return r.abort();
        return r.continue();
      });
    }
    const page = await ctx.newPage();
    const logs = [], errs = [];
    page.on('console', m => logs.push(m.type() + '|' + m.text()));
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    return { ctx, page, logs, errs };
  }
  const btnText = (page) => page.evaluate(() => {
    const b = document.getElementById('apkDirectLink');
    return b ? b.textContent.replace(/\s+/g, ' ').trim() : null;
  });

  // ---------- 场景一：正常读取实际体积 ----------
  console.log('===== 场景一 动态读取实际体积 =====');
  {
    const { ctx, page, logs, errs } = await open();
    const t = await btnText(page);
    console.log('   按钮文案: ' + t);
    check('按钮显示 1.0 MB（十进制，与实际字节数一致）', /（1\.0 MB）/.test(t), t);
    check('不再出现旧的 0.95 MB', !/0\.95/.test(t), t);
    check('静态兜底也已是 1.0 MB', !/0\.9/.test(await page.evaluate(() =>
      document.documentElement.outerHTML.match(/data-apk-size[^>]*>([^<]*)</)[1])), '');
    check('无 JS 报错', errs.length === 0, errs.join(' | '));

    // 口径函数本身（边界值）
    const cases = await page.evaluate(() => ({
      '994555（旧包）': fmtApkSize(994555),
      '1000000': fmtApkSize(1000000),
      '1003040（当前）': fmtApkSize(1003040),
      '4300000': fmtApkSize(4300000),
      '0': fmtApkSize(0)
    }));
    console.log('   口径: ' + JSON.stringify(cases));
    check('994555 B → 0.99 MB', cases['994555（旧包）'] === '0.99 MB', cases['994555（旧包）']);
    check('1000000 B → 1.0 MB', cases['1000000'] === '1.0 MB', cases['1000000']);
    check('1003040 B → 1.0 MB', cases['1003040（当前）'] === '1.0 MB', cases['1003040（当前）']);
    check('4300000 B → 4.3 MB', cases['4300000'] === '4.3 MB', cases['4300000']);
    check('0 B 返回空串', cases['0'] === '', JSON.stringify(cases['0']));
    await ctx.close();
  }

  // ---------- 场景二：HEAD 失败时沿用静态兜底 ----------
  console.log('===== 场景二 HEAD 取不到时沿用静态兜底 =====');
  {
    const { ctx, page, logs, errs } = await open({ breakHead: true });
    const t = await btnText(page);
    console.log('   按钮文案: ' + t);
    console.log('   控制台: ' + JSON.stringify(logs.filter(l => /体积读取失败/.test(l))));
    check('按钮仍显示可读体积（静态兜底 1.0 MB）', /（1\.0 MB）/.test(t), t);
    check('给出了可定位的告警', logs.some(l => /体积读取失败/.test(l)), '');
    check('无未捕获异常', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景三：移动端弹窗内显示正常 ----------
  console.log('===== 场景三 移动端 =====');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    await page.evaluate(() => { document.getElementById('appDownloadEntry').click(); });
    await page.waitForTimeout(400);
    const t = await page.evaluate(() => {
      const b = document.getElementById('apkDirectLink');
      return b.textContent.replace(/\s+/g, ' ').trim();
    });
    const shown = await page.evaluate(() => {
      const b = document.getElementById('apkDirectLink');
      const r = b.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, height: Math.round(r.height) };
    });
    console.log('   移动端按钮: ' + t + ' 可见=' + shown.visible);
    check('移动端弹窗内体积正确', /（1\.0 MB）/.test(t), t);
    check('按钮正常可见', shown.visible === true, JSON.stringify(shown));
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
