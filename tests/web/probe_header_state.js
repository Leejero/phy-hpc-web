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
/* 顶栏首屏状态 + 展开/收起回归
   背景：collapsedHeaderH() 为量「收起高度」会给顶栏加 .scrolled 却不还原，
        dispatchMeasure 也不还原 → 任何在启动期调用它的代码都会把顶栏永久留在收起态，
        而 .header-spacer 仍是展开高度 → 顶栏与「更新策略」之间空出 140~160px。
   覆盖：首屏必须是展开态 / 占位块与顶栏等高 / 空白合理 / 滚动后正常收放 / 量高函数无副作用
   用法：与 python -m http.server 8793（root=_public-repo-tmp）同一条命令内启停 */
const { chromium } = require('playwright');
const fs = require('fs');
// ⚠ 用固定的线上数据快照会「过期」：快照的 collected_at 一旦超过 3 小时，
//   页面会（正确地）显示「服务器离线」条幅，把首个标题往下推 60~100px，
//   于是这里量到的「顶栏到首节的空白」就不是布局本身的空白了。故把时间戳刷成当前。
const RAW = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
function nowStr() {
  const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T'
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.000000';
}
function freshData() {
  const d = JSON.parse(JSON.stringify(RAW));
  const t = nowStr();
  d.timestamp = Object.assign({}, d.timestamp, { collected_at: t });
  d.last_updated = t.replace('T', ' ').slice(0, 19);
  d.overview = Object.assign({}, d.overview, { last_updated: d.last_updated });
  return JSON.stringify(d);
}
const LIVE = freshData();
// ORIGIN 见文件头
let pass = 0, fail = 0;
const check = (n, ok, x) => {
  console.log((ok ? '  [OK]   ' : '  [FAIL] ') + n + (x !== undefined ? '  → ' + x : ''));
  ok ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  for (const [w, h, mob] of [[390, 844, true], [360, 740, true], [768, 1024, true], [1440, 900, false]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob, hasTouch: mob, deviceScaleFactor: 1 });
    await ctx.route('**/slurm.json*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: LIVE
    }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.fetching === false, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);

    const snap = () => page.evaluate(() => {
      const hd = document.querySelector('.header');
      const sp = document.querySelector('.header-spacer');
      const first = document.querySelector('#app .section-title');
      return {
        y: Math.round(window.scrollY),
        scrolled: hd.classList.contains('scrolled'),
        headerH: Math.round(hd.getBoundingClientRect().height),
        spacerH: Math.round(sp.getBoundingClientRect().height),
        gap: first ? Math.round(first.getBoundingClientRect().top - hd.getBoundingClientRect().bottom) : null
      };
    });

    console.log(`\n=== ${w}×${h} ===`);
    const s0 = await snap();
    console.log('   首屏: ' + JSON.stringify(s0));
    check(`${w}px 首屏顶栏为展开态（无 .scrolled）`, s0.scrolled === false, s0.scrolled);
    check(`${w}px 首屏顶栏与占位块等高`, Math.abs(s0.headerH - s0.spacerH) <= 1, s0.headerH + ' vs ' + s0.spacerH);
    check(`${w}px 首屏顶栏到首节无大片空白（<60px）`, s0.gap !== null && s0.gap < 60, s0.gap);

    // 量高函数不得留下副作用
    const side = await page.evaluate(() => {
      const hd = document.querySelector('.header');
      const before = hd.classList.contains('scrolled');
      const hCollapsed = collapsedHeaderH();
      const after = hd.classList.contains('scrolled');
      const hExpand = dispatchMeasure(hd, function () { hd.classList.remove('scrolled'); });
      const after2 = hd.classList.contains('scrolled');
      return { before: before, after: after, after2: after2, hCollapsed: Math.round(hCollapsed), hExpand: Math.round(hExpand) };
    });
    console.log('   量高: ' + JSON.stringify(side));
    check(`${w}px collapsedHeaderH() 无副作用（类状态不变）`, side.before === side.after, side.before + '→' + side.after);
    check(`${w}px dispatchMeasure 也不会自作主张改状态`, side.after2 === side.after, side.after2);
    check(`${w}px 收起高度明显小于展开高度`, side.hCollapsed < side.hExpand - 40, side.hCollapsed + ' vs ' + side.hExpand);

    // 滚动 → 收起；回到顶部 → 展开
    await page.evaluate(() => window.scrollTo(0, 600));
    await sleep(600);
    const down = await snap();
    check(`${w}px 下滚后顶栏收起`, down.scrolled === true && down.headerH < side.hExpand - 40, 'scrolled=' + down.scrolled + ' h=' + down.headerH);
    await page.evaluate(() => window.scrollTo(0, 0));
    // ⚠ 不能固定等待：展开过渡 0.3s + 浏览器繁忙时可能更久，量到中间值会差几像素
    //   （本次实测偶发 177 vs 180）。改为轮询到顶栏高度连续两次不变。
    let prevH = -1, stable = 0;
    for (let i = 0; i < 24; i++) {
      const h = await page.evaluate(() => Math.round(document.querySelector('.header').getBoundingClientRect().height));
      if (h === prevH) stable++; else stable = 0;
      prevH = h;
      if (stable >= 2) break;
      await sleep(120);
    }
    const top = await snap();
    check(`${w}px 回到顶部后顶栏展开`, top.scrolled === false, 'scrolled=' + top.scrolled + ' y=' + top.y);
    check(`${w}px 回顶后仍与占位块等高`, Math.abs(top.headerH - top.spacerH) <= 1, top.headerH + ' vs ' + top.spacerH);
    check(`${w}px 无 JS 报错`, errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
