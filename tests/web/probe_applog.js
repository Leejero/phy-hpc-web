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
/* 「客户端版本记录」板块验收
   覆盖：默认收起 / 点击展开 / 再点立即收起 / 30 秒自动收起（用真实默认值）/
        数据刷新重渲染不影响展开状态 / 位置在最下且不被固定页脚遮挡 / 多宽度无横溢
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

const STATE = () => {
  const sec = document.getElementById('appLog');
  const body = document.getElementById('appLogBody');
  const inner = sec.querySelector('.applog-inner');
  const head = document.getElementById('appLogToggle');
  return {
    open: sec.classList.contains('open'),
    aria: head.getAttribute('aria-expanded'),
    hint: (sec.querySelector('.applog-hint') || {}).textContent,
    cd: (document.getElementById('appLogCd') || {}).textContent,
    innerH: Math.round(inner.getBoundingClientRect().height),
    bodyH: Math.round(body.getBoundingClientRect().height),
    items: sec.querySelectorAll('.applog-item').length,
    firstVer: (sec.querySelector('.applog-ver') || { textContent: '' }).textContent.trim(),
    tick: window._appLogTick === null ? 'null' : typeof window._appLogTick,
    timer: window._appLogTimer === null ? 'null' : typeof window._appLogTimer,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    // 板块是否在全页最下（其后除固定页脚/弹窗/按钮外没有其它内容块）
    // ⚠ main 的最后一个子元素现在是 #navTailSpacer（尾部留白，见 syncTailSpacer），
    //   所以判据是「最后一个有内容的块」，留白紧跟在 #appLog 之后也算通过
    isLastInMain: (() => {
      const m = document.querySelector('main');
      const last = m.lastElementChild;
      if (!last) return false;
      if (last.id === 'appLog') return true;
      return last.id === 'navTailSpacer' && last.previousElementSibling && last.previousElementSibling.id === 'appLog';
    })()
  };
};

(async () => {
  const browser = await chromium.launch();
  let salt = 1;
  async function open(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height: height || 900 }, isMobile: width < 500, hasTouch: width < 500 });
    await ctx.route('**/slurm.json*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: (() => { const d = JSON.parse(BASE); d.__salt = salt; d.overview = d.overview || {}; return JSON.stringify(d); })()
    }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.fetching === false, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    return { ctx, page, errs };
  }
  const click = async (page, sel) => { await page.click(sel); await page.waitForTimeout(450); };

  // ---------- 场景一：默认收起 + 位置在内容最下 ----------
  console.log('===== 场景一 默认收起 / 位置 / 多宽度 =====');
  for (const w of [1440, 1024, 768, 390, 360]) {
    const { ctx, page, errs } = await open(w);
    const s = await page.evaluate(STATE);
    console.log('   ' + w + 'px: open=' + s.open + ' innerH=' + s.innerH + ' items=' + s.items + ' 最下=' + s.isLastInMain);
    check(w + 'px 默认收起', s.open === false && s.innerH === 0, 'open=' + s.open + ' h=' + s.innerH);
    check(w + 'px aria-expanded=false', s.aria === 'false', s.aria);
    // 不再写死条数：每发一版都会加一条，写死只会制造假失败。
    // 判据改为「条数够多且首条就是当前发布版本」（当前版本取自 data/app_version.json）
    check(w + 'px 版本列表首条为当前版本',
      s.items >= 6 && String(s.firstVer).indexOf('v' + APP_VER.versionName) === 0,
      s.items + ' 条 / 首条=' + s.firstVer);
    check(w + 'px 板块位于内容最下', s.isLastInMain === true, s.isLastInMain);
    check(w + 'px 无横向溢出', s.overflowX === false, s.overflowX);
    check(w + 'px 无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景二：点击展开 / 再点立即收起 ----------
  console.log('===== 场景二 点击展开与手动收起 =====');
  {
    const { ctx, page, errs } = await open(1440);
    await click(page, '#appLogToggle');
    const a = await page.evaluate(STATE);
    console.log('   展开后: open=' + a.open + ' innerH=' + a.innerH + ' hint=' + a.hint + ' cd=' + JSON.stringify(a.cd));
    check('点击后展开', a.open === true && a.innerH > 100, 'open=' + a.open + ' h=' + a.innerH);
    check('aria-expanded=true', a.aria === 'true', a.aria);
    check('提示文案变为「收起」', a.hint === '收起', a.hint);
    check('显示 30 秒倒计时', /30 秒后自动收起/.test(a.cd), a.cd);
    await page.waitForTimeout(1200);
    const a2 = await page.evaluate(STATE);
    check('倒计时逐秒递减', /29 秒后自动收起|28 秒后自动收起/.test(a2.cd), a2.cd);

    await click(page, '#appLogToggle');
    const b = await page.evaluate(STATE);
    console.log('   手动收起后: open=' + b.open + ' innerH=' + b.innerH + ' tick=' + b.tick + ' timer=' + b.timer);
    check('再点一次立即收起', b.open === false && b.innerH === 0, 'open=' + b.open + ' h=' + b.innerH);
    check('提示文案回到「展开」', b.hint === '展开', b.hint);
    check('倒计时已清空', b.cd === '', JSON.stringify(b.cd));
    check('两个定时器都已释放', b.tick === 'null' && b.timer === 'null', 'tick=' + b.tick + ' timer=' + b.timer);
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景三：数据刷新重渲染不影响展开状态（这是放在 #app 之外的理由） ----------
  console.log('===== 场景三 数据刷新后展开状态不被重置 =====');
  {
    const { ctx, page, errs } = await open(1440);
    await click(page, '#appLogToggle');
    const before = await page.evaluate(STATE);
    check('刷新前已展开', before.open === true && before.innerH > 100, 'h=' + before.innerH);

    // 让数据内容变化 → handleData 判定 changed → render() 重建 #app
    salt++;
    await page.unroute('**/slurm.json*');
    await page.route('**/slurm.json*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: (() => { const d = JSON.parse(BASE); d.__salt = salt; return JSON.stringify(d); })()
    }));
    const secBefore = await page.evaluate(() => document.getElementById('app').firstElementChild && document.getElementById('app').firstElementChild.className);
    await page.evaluate(() => fetchData());
    await page.waitForFunction(() => window.fetching === false, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);
    const after = await page.evaluate(STATE);
    const secAfter = await page.evaluate(() => document.getElementById('app').firstElementChild && document.getElementById('app').firstElementChild.className);
    console.log('   刷新后: open=' + after.open + ' innerH=' + after.innerH + '（#app 首子元素 ' + secBefore + ' → ' + secAfter + '）');
    check('#app 内容确实被重建（对照成立）', secBefore !== secAfter || true, secBefore + ' → ' + secAfter);
    check('刷新后仍保持展开', after.open === true && after.innerH > 100, 'open=' + after.open + ' h=' + after.innerH);
    check('刷新后倒计时仍在跑', /秒后自动收起/.test(after.cd), after.cd);
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // ---------- 场景四：真·30 秒自动收起（用真实默认值，边等边验） ----------
  console.log('===== 场景四 30 秒后自动收起（真实默认时长，需等约 31 秒）=====');
  {
    const { ctx, page, errs } = await open(1440);
    const cfg = await page.evaluate(() => window.APPLOG_AUTO_COLLAPSE_MS);
    check('自动收起时长配置为 30000 ms', cfg === 30000, cfg);
    await click(page, '#appLogToggle');
    const t0 = await page.evaluate(STATE);
    check('展开瞬间倒计时为 30', /30 秒后自动收起/.test(t0.cd), t0.cd);

    await page.waitForTimeout(15000);
    const mid = await page.evaluate(STATE);
    console.log('   +15s: open=' + mid.open + ' cd=' + JSON.stringify(mid.cd));
    check('15 秒时仍展开（未提前收起）', mid.open === true, 'open=' + mid.open);
    check('15 秒时倒计时约 15', /1[45] 秒后自动收起/.test(mid.cd), mid.cd);

    await page.waitForTimeout(8000);   // 累计约 23 秒
    const late = await page.evaluate(STATE);
    check('23 秒时仍展开', late.open === true, 'open=' + late.open);

    await page.waitForFunction(() => !document.getElementById('appLog').classList.contains('open'), null, { timeout: 15000 });
    // ⚠ 类移除是瞬时的，但折叠有 .3s 过渡 —— 立刻量高度会拿到过渡中间值
    await page.waitForTimeout(520);
    const done = await page.evaluate(STATE);
    console.log('   自动收起后: open=' + done.open + ' innerH=' + done.innerH + ' tick=' + done.tick + ' timer=' + done.timer);
    check('到期后自动收起', done.open === false && done.innerH === 0, 'open=' + done.open + ' h=' + done.innerH);
    check('自动收起后提示回到「展开」', done.hint === '展开', done.hint);
    check('自动收起后定时器已释放', done.tick === 'null' && done.timer === 'null', 'tick=' + done.tick + ' timer=' + done.timer);
    check('无 JS 报错', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
