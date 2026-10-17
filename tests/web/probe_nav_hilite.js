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
/* 侧栏滚动高亮验收
   背景：跳转落点是「顶栏下沿 + NAV_LAND_GAP(12)」，而高亮判定线原是「顶栏下沿 + 8」——
        差 4px → 跳转后目标标题仍在判定线之下 → 高亮停在上一节（除首、尾外全错）。
   覆盖：点击每项后高亮是否正确 / 手动滚到各节中部 / 滚到页面底部 / 手工校验常量关系
   用法：与 python -m http.server 8793（root=_public-repo-tmp）同一条命令内启停 */
const { chromium } = require('playwright');
const fs = require('fs');
const LIVE = fs.readFileSync(FIXTURE, 'utf8');
// ORIGIN 见文件头
let pass = 0, fail = 0;
const check = (n, ok, x) => {
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + n + (x !== undefined ? '  → ' + x : ''));
  ok ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NAV = ['announcement', 'overview', 'partitions', 'alerts', 'disks', 'qos', 'nodes', 'jobs', 'users', 'online', 'appLog'];

(async () => {
  const browser = await chromium.launch();
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
    await ctx.route('**/slurm.json*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: LIVE
    }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.fetching === false, null, { timeout: 15000 }).catch(() => {});
    await sleep(900);
    if (w <= 1024) { await page.click('#sidebarToggle'); await sleep(450); }

    async function settle() {
      let last = -1, st = 0;
      for (let i = 0; i < 34; i++) {
        const y = await page.evaluate(() => Math.round(window.scrollY));
        if (y === last) st++; else st = 0;
        last = y; if (st >= 2 && i > 3) return y;
        await sleep(220);
      }
      return last;
    }
    const active = () => page.evaluate(() => {
      const a = document.querySelector('.sidebar-nav a.active');
      return a ? a.getAttribute('data-section') : null;
    });

    // ≤1024px 时点完一次导航，侧栏会在 300ms 后自动收起；而侧栏展开时 #sidebarToggle 是隐藏的，
    // 所以必须先判断是否已收起，再决定要不要点开。
    async function ensureSidebar() {
      if (w > 1024) return;
      const open = await page.evaluate(() => document.getElementById('sidebar').classList.contains('open'));
      if (!open) { await page.click('#sidebarToggle'); await sleep(450); }
    }

    console.log(`\n=== ${w}×${h} ===`);
    // 常量关系本身（防止日后有人只改一边）
    const c = await page.evaluate(() => ({ land: window.NAV_LAND_GAP, hilite: window.NAV_HILITE_GAP }));
    const hd0 = await page.evaluate(() => ({ v: typeof collapsedHeaderH === 'function' ? collapsedHeaderH() : 0 }));
    const landed = Math.round(hd0.v + c.land);
    const line = Math.round(hd0.v + c.hilite);
    console.log(`   常量: LAND=${c.land} HILITE=${c.hilite} → 落点 ${landed}px、判定线 ${line}px`);
    check(`${w}px 判定线比跳转落点更靠下（否则必然差一节）`, c.hilite > c.land, 'HILITE=' + c.hilite + ' LAND=' + c.land);

    // ① 点击每一项后，高亮必须就是该项
    for (const id of NAV) {
      await ensureSidebar();
      await page.click(`.sidebar-nav a[data-section="${id}"]`);
      await settle(); await sleep(260);
      const act = await active();
      check(`${w}px 点击 ${id} 后高亮正确`, act === id, '高亮=' + act);
    }

    // ② 手动滚到各节中部，高亮应为该节
    // ⚠ 只测离底部足够远的节：靠底的节滚到「中部」时会被夹在页面最底部，
    //   从而触发「到底高亮最后一节」的规则（那是预期行为，不是错高亮）
    // ⚠ 必须先派发一次用户滚动事件：点击导航会把高亮「锁定」在目标项上（见 lockSidebarActive），
    //   而 window.scrollTo 属于程序化滚动、不会解除锁定 —— 真实用户滚动会派发 wheel。
    for (const id of ['jobs', 'users']) {
      const top = await page.evaluate((sid) => {
        const el = document.getElementById(sid);
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
        window.scrollTo(0, el.offsetTop + 320);
        return Math.round(el.offsetTop);
      }, id);
      await settle(); await sleep(220);
      const act = await active();
      check(`${w}px 滚到 ${id} 中部高亮正确`, act === id, 'offsetTop=' + top + ' 高亮=' + act);
    }

    // ②b 用户滚动（wheel）应解除锁定，交回按位置判定
    {
      await ensureSidebar();
      await page.click('.sidebar-nav a[data-section="online"]');
      await settle(); await sleep(300);
      const locked = await active();
      await page.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 })); window.scrollTo(0, 0); });
      await settle(); await sleep(300);
      const released = await active();
      check(`${w}px 点击后高亮锁定在目标项`, locked === 'online', locked);
      check(`${w}px 用户滚动后解除锁定（回到按位置判定）`, released === 'announcement' || released === 'overview', '锁定=' + locked + ' → 滚动后=' + released);
    }

    // ③ 滚到最底部 → 高亮最后一节
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollTo(0, 10e6)); await sleep(340); }
    const bottom = await active();
    check(`${w}px 滚到底部高亮最后一节`, bottom === 'appLog', bottom);
    check(`${w}px 无 JS 报错`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
