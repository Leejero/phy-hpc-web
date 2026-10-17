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
// 验收：排队原因板块改为「卡片网格 + 两行」后的渲染、行数、断点自适应、跳转高亮
const { chromium } = require('playwright');

const URL = ORIGIN + '/index.html';
const VP = [
  { w: 1440, name: '1440' }, { w: 1024, name: '1024' }, { w: 768, name: '768' },
  { w: 640, name: '640' }, { w: 420, name: '420' }, { w: 360, name: '360' }
];

(async () => {
  const b = await chromium.launch();
  for (const vp of VP) {
    const p = await b.newPage({ viewport: { width: vp.w, height: 900 }, deviceScaleFactor: 1 });
    const errs = [];
    p.on('pageerror', e => errs.push(String(e)));
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2000);
    await p.evaluate(() => { const n = document.getElementById('appNotice'); if (n) n.style.display = 'none'; });

    console.log('\n===== w=' + vp.w + ' =====');
    console.log('页面错误: ' + (errs.length ? errs.join(' | ') : '无'));

    // ① 卡片数量、列数、每张卡的子行数与高度
    const info = await p.evaluate(() => {
      const grid = document.querySelector('.reason-grid');
      if (!grid) return null;
      const cs = getComputedStyle(grid);
      const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
      const cards = [...grid.querySelectorAll('.rg-card')];
      const detail = cards.map(c => {
        const top = c.querySelector('.rg-top'), desc = c.querySelector('.rg-desc');
        const tb = top ? top.getBoundingClientRect() : null;
        const db = desc ? desc.getBoundingClientRect() : null;
        return {
          code: (c.querySelector('.reason-code') || {}).textContent || '?',
          manual: c.classList.contains('is-manual'),
          live: c.classList.contains('is-live'),
          jump: c.classList.contains('is-jump'),
          // 第一行与第二行是否各自只占一行（desc 若换行则行高比 lineHeight 高）
          topH: tb ? Math.round(tb.height) : -1,
          descH: db ? Math.round(db.height) : -1,
          descLineH: desc ? Math.round(parseFloat(getComputedStyle(desc).lineHeight)) : -1,
          cardH: Math.round(c.getBoundingClientRect().height),
          hasLiveTag: !!c.querySelector('.rg-live-tag'),
          modeText: (c.querySelector('.rg-mode') || {}).textContent || '',
          descText: desc ? desc.textContent : ''
        };
      });
      return { cols, gap: cs.gap, count: cards.length, detail };
    });
    if (!info) { console.log('!! 未找到 .reason-grid'); await p.close(); continue; }
    console.log('① 卡片数 = ' + info.count + ' | 列数 = ' + info.cols + ' | gap = ' + info.gap);
    info.detail.forEach(d => console.log('   ' + d.code.padEnd(26)
      + ' 卡高' + String(d.cardH).padStart(3)
      + ' top行' + String(d.topH).padStart(3)
      + ' desc高' + String(d.descH).padStart(3) + '/行高' + d.descLineH
      + (d.descH > d.descLineH + 2 ? ' ⚠折行' : '')
      + (d.hasLiveTag ? ' [排队中]' : '')
      + ' ' + d.modeText));
    // 行高一致性（同列同排卡片理想等高）
    const hs = info.detail.map(d => d.cardH);
    console.log('   卡片高度区间 ' + Math.min(...hs) + '~' + Math.max(...hs) + 'px（差 ' + (Math.max(...hs) - Math.min(...hs)) + 'px）');

    // ② 横向溢出（板块 / 卡片 / 页面）
    const over = await p.evaluate(() => {
      const blk = document.querySelector('.reason-block');
      const grid = document.querySelector('.reason-grid');
      return {
        block: blk ? blk.scrollWidth - blk.clientWidth : -1,
        grid: grid ? grid.scrollWidth - grid.clientWidth : -1,
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    console.log('② 横溢 板块=' + over.block + 'px 网格=' + over.grid + 'px 整页=' + over.doc + 'px');

    // ③ 板块总高
    const h = await p.evaluate(() => {
      const blk = document.querySelector('.reason-block');
      return blk ? Math.round(blk.getBoundingClientRect().height) : -1;
    });
    console.log('③ 板块高度 = ' + h + 'px');

    await p.close();
  }

  // ④ 跳转：人为造 3 条同原因 PENDING，验证是否三条全部高亮
  {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(URL, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2000);
    await p.evaluate(() => { const n = document.getElementById('appNotice'); if (n) n.style.display = 'none'; });
    const r = await p.evaluate(async () => {
      const tb = document.getElementById('jobTable');
      if (!tb) return { err: '无 jobTable' };
      const rows = [...tb.querySelectorAll('tbody tr')];
      // 先把真实数据里的 PENDING 全部抹掉，排除干扰
      rows.forEach(tr => { tr.setAttribute('data-status', 'RUNNING'); tr.removeAttribute('data-reason'); });
      // 造 3 条同一原因、彼此隔开的 PENDING 行（第 1、2、5 行）
      [0, 1, 4].forEach(i => {
        if (!rows[i]) return;
        rows[i].setAttribute('data-status', 'PENDING');
        rows[i].setAttribute('data-reason', '(AssocMaxJobsLimit)');
      });
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 200));
      const ok = window.jumpToPendingTasks('AssocMaxJobsLimit');
      await new Promise(r => setTimeout(r, 1500));
      const hit = [...document.querySelectorAll('#jobTable tbody tr.row-hit')];
      const hd = document.querySelector('.header').getBoundingClientRect().bottom;
      const thead = tb.tHead ? tb.tHead.getBoundingClientRect().bottom : 0;
      return {
        ok, hits: hit.length,
        idx: hit.map(tr => rows.indexOf(tr)),
        scrollY: Math.round(window.scrollY),
        firstTop: hit[0] ? Math.round(hit[0].getBoundingClientRect().top) : -1,
        headerBottom: Math.round(hd), theadBottom: Math.round(thead),
        // 首行顶边若在顶栏下沿之上即为被遮挡（表头底边视口坐标 = 首行落点参照）
        blocked: hit[0] ? hit[0].getBoundingClientRect().top < hd - 2 : null,
      };
    });
    console.log('\n===== 跳转（人造 3 条同原因）=====');
    console.log('返回 = ' + r.ok + ' | 高亮行数 = ' + r.hits + '（应为 3）| 命中行序号 = ' + JSON.stringify(r.idx));
    console.log('scrollY = ' + r.scrollY + ' | 首行 top = ' + r.firstTop
      + 'px（顶栏下沿 ' + r.headerBottom + ' + 表头 ' + r.theadBottom + 'px）| 被遮挡 = ' + r.blocked);
    // 2.4s 后褪去
    await p.waitForTimeout(1400);
    const after = await p.evaluate(() => document.querySelectorAll('#jobTable tbody tr.row-hit').length);
    console.log('2.4s 后残留高亮 = ' + after + '（应为 0）');
    await p.screenshot({ path: path.join(ROOT, 'tests', '.tmp', 'cards_desk.png'), clip: { x: 0, y: 0, width: 1440, height: 900 } });
    await p.close();
  }

  await b.close();
})();
