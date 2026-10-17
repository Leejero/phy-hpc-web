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
/* 侧栏跳转可达性验收
   背景：页面末尾几节「滚到标题贴顶栏下沿」的目标位置会超过最大滚动量，滚动被夹住 →
        点侧栏看起来「没反应」。修复靠 main.js 的 syncTailSpacer() 补足尾部留白。
   覆盖：A 各窗口高度下最靠底的几项 B 指定窗口下全部 11 项 C 用户原始路径（appLog 收起后点上面两节）
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const NAV = ['announcement', 'overview', 'partitions', 'alerts', 'disks', 'qos', 'nodes', 'jobs', 'users', 'online', 'appLog'];

(async () => {
  const browser = await chromium.launch();

  async function open(vh) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: vh } });
    await ctx.route('**/slurm.json*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: LIVE
    }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.fetching === false, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    return { ctx, page, errs };
  }
  async function settle(page) {
    let last = -1, stable = 0;
    for (let i = 0; i < 34; i++) {
      const y = await page.evaluate(() => Math.round(window.scrollY));
      if (y === last) stable++; else stable = 0;
      last = y;
      if (stable >= 2 && i > 3) return y;
      await sleep(220);
    }
    return last;
  }
  const toBottom = async (page) => { for (let i = 0; i < 4; i++) { await page.evaluate(() => window.scrollTo(0, 10e6)); await sleep(350); } };
  // 点击导航项并返回落点信息
  async function jump2(page, id) {
    const before = await page.evaluate(() => Math.round(window.scrollY));
    await page.click(`.sidebar-nav a[data-section="${id}"]`);
    await settle(page);
    await sleep(200);
    const after = await page.evaluate((sid) => {
      const el = document.getElementById(sid);
      const hd = document.querySelector('.header');
      const r = el.getBoundingClientRect();
      return {
        y: Math.round(window.scrollY), titleTop: Math.round(r.top),
        maxY: document.documentElement.scrollHeight - window.innerHeight,
        headerH: Math.round(hd.getBoundingClientRect().height),
        spacer: Math.round(document.getElementById('navTailSpacer').offsetHeight)
      };
    }, id);
    after.delta = after.y - before;
    return after;
  }

  // ---------- 场景 A：各窗口高度下，最靠底的几项 ----------
  console.log('===== 场景A 各窗口高度下最靠底的三项（从页面底部点击）=====');
  for (const vh of [600, 800, 1000, 1200]) {
    const { ctx, page, errs } = await open(vh);
    const line = [];
    for (const id of ['users', 'online', 'appLog']) {
      await toBottom(page);
      const r = await jump2(page, id);
      line.push(`${id}: titleTop=${r.titleTop} Δ=${r.delta}`);
      // 判据：标题落到视口上部。
      // ⚠ 靠底部的节落点已放宽到「视口上部 30%」（贴顶要给下面留将近一整屏空白，
      //   用户反馈「底部空白太大」）；appLog 是最后一节，下方无内容可撑，只会更低。
      const upper = id === 'appLog' ? Math.round(vh * 0.6) : Math.round(vh * 0.35) + 20;
      check(`vh=${vh} ${id} 标题落到视口上部`, r.titleTop >= 0 && r.titleTop <= upper, 'titleTop=' + r.titleTop + ' Δ=' + r.delta);
    }
    console.log('   vh=' + vh + '  ' + line.join(' | ') + '  spacer=' + (await page.evaluate(() => document.getElementById('navTailSpacer').offsetHeight)));
    check(`vh=${vh} 无 JS 报错`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景 B：指定窗口下全部 11 项 ----------
  console.log('===== 场景B vh=900 全部 11 项（每项都从页面底部点击）=====');
  {
    const { ctx, page, errs } = await open(900);
    for (const id of NAV) {
      await toBottom(page);
      const r = await jump2(page, id);
      // 场景 B 固定 vh=900（此处没有 vh 变量）
      const upper = id === 'appLog' ? Math.round(900 * 0.6) : Math.round(900 * 0.35) + 20;
      const ok = r.titleTop >= 0 && r.titleTop <= upper;
      console.log('   ' + id.padEnd(12) + ' titleTop=' + String(r.titleTop).padStart(4) + ' Δ=' + String(r.delta).padStart(5) + (ok ? '' : '   ★未落到上部'));
      check(`vh=900 ${id} 可达`, ok, 'titleTop=' + r.titleTop);
    }
    check('vh=900 无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景 C：用户原始路径（appLog 展开→收起后，点上面两节） ----------
  console.log('===== 场景C 用户原始路径：点 App 功能迭代 → 面板收起 → 点上面两节 =====');
  for (const vh of [900, 1200]) {
    const { ctx, page, errs } = await open(vh);
    await page.click('.sidebar-nav a[data-section="appLog"]');
    await settle(page); await sleep(300);
    // 模拟 30 秒自动收起后的状态（比真等 30 秒快，且状态等价）
    await page.evaluate(() => collapseAppLog());
    await sleep(500);
    for (const id of ['online', 'users']) {
      const r = await jump2(page, id);
      const act = await page.evaluate(() => { const a = document.querySelector('.sidebar-nav a.active'); return a ? a.getAttribute('data-section') : null; });
      console.log(`   vh=${vh} 收起后点 ${id}: titleTop=${r.titleTop} Δ=${r.delta} 高亮=${act}`);
      // 落点放宽后，若本来就停在页面底部且该节已在上部，可能不再产生位移：
      // 此时「响应」由侧栏高亮锁定提供（点击即高亮目标项），故校验落点 + 高亮，而不是强求 Δ>0
      check(`vh=${vh} 收起后 ${id} 落到视口上部且高亮锁定到该项`,
        r.titleTop >= 0 && r.titleTop <= Math.round(vh * 0.35) + 20 && act === id,
        'titleTop=' + r.titleTop + ' Δ=' + r.delta + ' 高亮=' + act);
    }
    check(`vh=${vh} 无 JS 报错`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
