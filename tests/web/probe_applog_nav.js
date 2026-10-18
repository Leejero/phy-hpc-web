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
/* 「客户端版本记录」侧栏入口验收
   覆盖：侧栏条目存在且为最后一项 / 点击跳转并顺手展开 / 落点不被顶栏遮挡 /
        滚到底时该项高亮 / v1.0.0 日期为 2026-07-29 / 图标正常渲染 / 手机端 App 入口未受影响
   用法：与 python -m http.server 8793（root=_public-repo-tmp）同一条命令内启停 */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = fs.readFileSync(FIXTURE, 'utf8');
// ORIGIN 见文件头
let pass = 0, fail = 0;
const check = (n, ok, x) => {
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + n + (x !== undefined ? '  → ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  const browser = await chromium.launch();
  async function open(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height: height || 900 }, isMobile: width < 500, hasTouch: width < 500 });
    await ctx.route('**/slurm.json*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: BASE
    }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.fetching === false, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    // ⚠ ≤1024px 时侧栏默认是收起状态（transform 移到屏外），要先点开汉堡按钮
    if (width <= 1024) {
      await page.click('#sidebarToggle');
      await page.waitForTimeout(450);
    }
    return { ctx, page, errs };
  }

  // 等平滑滚动真正停稳：固定等待不可靠 —— 跳转有 340ms 延迟，且动画时长随距离变化
  //（手机端页面更高，动画更久）。要求「连续两次读数相同」且至少过了 900ms（覆盖延迟）。
  async function waitScrollSettled(page, timeoutMs) {
    const t0 = Date.now();
    let last = -1, stable = 0;
    while (Date.now() - t0 < (timeoutMs || 8000)) {
      const y = await page.evaluate(() => Math.round(window.scrollY));
      if (y === last) stable++; else stable = 0;
      last = y;
      if (stable >= 2 && Date.now() - t0 > 900) return y;
      await page.waitForTimeout(280);
    }
    return last;
  }

  // ---------- 场景一：侧栏条目 ----------
  console.log('===== 场景一 侧栏条目与图标 =====');
  {
    const { ctx, page, errs } = await open(1440);
    const r = await page.evaluate(() => {
      const links = [...document.querySelectorAll('.sidebar-nav a')];
      const mine = links.find(a => a.getAttribute('data-section') === 'appLog');
      const svg = mine ? mine.querySelector('svg') : null;
      const sr = svg ? svg.getBoundingClientRect() : null;
      return {
        count: links.length,
        isLast: links[links.length - 1] === mine,
        href: mine ? mine.getAttribute('href') : null,
        label: mine ? mine.textContent.trim() : null,
        iconW: sr ? Math.round(sr.width) : 0, iconH: sr ? Math.round(sr.height) : 0,
        useRef: svg ? (svg.querySelector('use').getAttribute('href')) : null,
        // 图标是否真的有内容（symbol 存在时 <use> 的 bbox 才有宽度）
        symbolExists: !!document.getElementById('ic-log'),
        v100Date: (() => {
          const items = [...document.querySelectorAll('.applog-item')];
          const last = items[items.length - 1];
          return last ? last.querySelector('.applog-ver').textContent.trim() : null;
        })()
      };
    });
    console.log('   ' + JSON.stringify(r));
    check('侧栏共 11 项（原 10 + 新增）', r.count === 11, r.count);
    check('新条目是侧栏最后一项', r.isLast === true, r.isLast);
    check('指向 #appLog', r.href === '#appLog', r.href);
    check('文案为「客户端版本记录」', r.label === '客户端版本记录', r.label);
    check('ic-log 符号已定义', r.symbolExists === true, r.symbolExists);
    check('图标正常渲染（有尺寸）', r.iconW > 0 && r.iconH > 0, r.iconW + '×' + r.iconH);
    // 1.0.x 已合并为一条汇总，末条不再是独立的 v1.0.0；
    // 只要求末条是老版本汇总（含 1.0.0 及起始日期 2026-07-29）
    check('末条为早期版本汇总（含 1.0.0 / 2026-07-29）',
      /1\.0\.0/.test(r.v100Date) && /2026-07-29/.test(r.v100Date), r.v100Date);
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景二：点击侧栏条目 → 跳转 + 展开 + 不被顶栏遮挡 ----------
  console.log('===== 场景二 点击侧栏条目 =====');
  for (const w of [1440, 390]) {
    const { ctx, page, errs } = await open(w);
    const before = await page.evaluate(() => ({ y: Math.round(window.scrollY), open: document.getElementById('appLog').classList.contains('open') }));
    check(w + 'px 初始未展开', before.open === false, before.open);

    await page.click('.sidebar-nav a[data-section="appLog"]');
    await waitScrollSettled(page);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const sec = document.getElementById('appLog');
      const head = document.getElementById('appLogToggle');
      const hd = document.querySelector('.header');
      const firstItem = sec.querySelector('.applog-item');
      const fr = firstItem.getBoundingClientRect();
      const sr = sec.getBoundingClientRect(), hr = head.getBoundingClientRect(), dr = hd.getBoundingClientRect();
      return {
        y: Math.round(window.scrollY), open: sec.classList.contains('open'),
        aria: head.getAttribute('aria-expanded'),
        innerH: Math.round(sec.querySelector('.applog-inner').getBoundingClientRect().height),
        headTop: Math.round(hr.top), headerBottom: Math.round(dr.bottom),
        covered: hr.top < dr.bottom - 2,
        cd: (document.getElementById('appLogCd') || {}).textContent,
        firstItemTop: Math.round(fr.top), viewportH: window.innerHeight,
        firstItemVisible: fr.top >= 0 && fr.top < window.innerHeight
      };
    });
    console.log('   ' + w + 'px: y ' + before.y + '→' + after.y + ' open=' + after.open + ' innerH=' + after.innerH +
      ' headTop=' + after.headTop + ' 首条内容 top=' + after.firstItemTop + '/' + after.viewportH);
    check(w + 'px 点击后发生滚动', after.y > before.y + 100, before.y + '→' + after.y);
    check(w + 'px 顺手展开', after.open === true && after.innerH > 100, 'open=' + after.open + ' h=' + after.innerH);
    check(w + 'px aria-expanded=true', after.aria === 'true', after.aria);
    check(w + 'px 倒计时已启动', /秒后自动收起/.test(after.cd), after.cd);
    check(w + 'px 标题未被顶栏遮挡', after.covered === false, 'headTop=' + after.headTop + ' headerBottom=' + after.headerBottom);
    // 它是页面最后一节：展开后（内容 + 底部留白）比视口矮，滚动到底也顶不到最上面，
    // 所以判据是「标题与首条内容都在视口内」，而不是标题贴顶。
    check(w + 'px 标题落在视口内', after.headTop >= 0 && after.headTop < 400, 'headTop=' + after.headTop);
    check(w + 'px 首条版本内容可见', after.firstItemVisible === true, 'top=' + after.firstItemTop + ' vh=' + after.viewportH);
    check(w + 'px 无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景三：滚到底时该项目高亮 ----------
  console.log('===== 场景三 滚动高亮 =====');
  {
    const { ctx, page, errs } = await open(1440);
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollTo(0, 10e6)); await page.waitForTimeout(400); }
    const r = await page.evaluate(() => {
      const active = document.querySelector('.sidebar-nav a.active');
      return active ? active.getAttribute('data-section') : null;
    });
    console.log('   滚到底高亮项: ' + r);
    check('滚到底时高亮「客户端版本记录」', r === 'appLog', r);
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景四：回归——侧栏「手机端 App」入口仍可弹窗 ----------
  console.log('===== 场景四 回归：手机端 App 入口 =====');
  {
    const { ctx, page, errs } = await open(1440);
    await page.click('#appDownloadEntry');
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({
      shown: document.getElementById('appModal').classList.contains('show'),
      btn: document.getElementById('apkDirectLink').textContent.replace(/\s+/g, ' ').trim()
    }));
    console.log('   下载弹窗: ' + JSON.stringify(r));
    check('「手机端 App」仍能打开下载弹窗', r.shown === true, r.shown);
    check('弹窗内体积仍为 1.0 MB', /（1\.0 MB）/.test(r.btn), r.btn);
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
