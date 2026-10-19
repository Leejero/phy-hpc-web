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
/* 发布前验收：下载弹窗版本号、体积、更新日期；新版提示弹窗文案与生效窗口；
   定时窗口是否落在今天；在线资源是否可访问 */
const { chromium } = require('playwright');

const BASE = ORIGIN + '/';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  [OK]  ' : '  [FAIL]') + ' ' + name + (extra !== undefined ? '  → ' + extra : ''));
  ok ? pass++ : fail++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // 等首屏数据渲染完毕
  await page.waitForTimeout(2500);

  console.log('===== ① 下载弹窗（#appModal）=====');
  const modal = await page.evaluate(() => {
    const m = document.getElementById('appModal');
    if (!m) return null;
    const sub = m.querySelector('.modal-sub');
    const notes = [...m.querySelectorAll('.modal-notes li')].map(li => li.textContent.trim());
    const btn = m.querySelector('#apkDirectLink');
    return {
      sub: sub ? sub.textContent.trim() : '',
      notes,
      btnText: btn ? btn.textContent.replace(/\s+/g, ' ').trim() : '',
      href: btn ? btn.getAttribute('href') : ''
    };
  });
  console.log('   副标题: ' + modal.sub);
  console.log('   按钮: ' + modal.btnText);
  console.log('   说明: ' + JSON.stringify(modal.notes));
  check('弹窗副标题为 v' + APP_VER.versionName, modal.sub.indexOf('v' + APP_VER.versionName) >= 0, modal.sub);
  check('说明行版本为 v' + APP_VER.versionName, modal.notes.some(t => t.indexOf('v' + APP_VER.versionName) >= 0), modal.notes[0]);
  check('说明行日期为 ' + APP_VER.released, modal.notes.some(t => t.indexOf(APP_VER.released) >= 0), modal.notes[0]);
  check('副标题无旧版本残留', !/v1\.0\.[0-6]/.test(modal.sub), modal.sub);
  check('直链指向 download/PhyHPC-Monitor.apk', /download\/PhyHPC-Monitor\.apk$/.test(modal.href), modal.href);

  console.log('===== ② 新版提示弹窗（#appNotice）=====');
  const notice = await page.evaluate(() => {
    const n = document.getElementById('appNotice');
    if (!n) return null;
    const cs = getComputedStyle(n);
    return {
      text: (n.querySelector('.notice-text') || {}).textContent || '',
      hidden: n.classList.contains('hidden') || cs.display === 'none' || cs.visibility === 'hidden',
      opacity: cs.opacity
    };
  });
  console.log('   文案: ' + notice.text.trim());
  check('提示文案含 v' + APP_VER.versionName, notice.text.indexOf('v' + APP_VER.versionName) >= 0, '');
  // 不再断言具体措辞：每次发版文案都会变，写死只会制造假失败。
  // 改为「完整性」判据 —— 版本号已在上一项校验过，这里只确保文案不是占位或残句。
  check('提示文案为完整句子（≥12 字）', notice.text.length >= 12, notice.text.length + ' 字');
  check('提示文案不再含旧的「78%」', !/78%/.test(notice.text), '');
  check('弹窗当前可见（落在生效窗口内）', notice.hidden === false, 'hidden=' + notice.hidden + ' opacity=' + notice.opacity);

  console.log('===== ③ 定时窗口判定（代码内取值）=====');
  const win = await page.evaluate(() => ({
    from: APP_NOTICE.from, until: APP_NOTICE.until,
    now: new Date().toString()
  }));
  const start = Date.parse(win.from), end = Date.parse(win.until), now = Date.now();
  console.log('   窗口: ' + win.from + ' ~ ' + win.until);
  console.log('   现在: ' + win.now);
  check('窗口起点不晚于当前时间', now >= start, 'diff=' + Math.round((now - start) / 3600000) + 'h');
  check('窗口终点晚于当前时间', now <= end, '剩 ' + Math.round((end - now) / 3600000) + 'h');
  // 不写死日期：窗口起点应等于本次发布日（取自 data/app_version.json 的 released）
  check('窗口起点为发布日 ' + APP_VER.released,
    win.from.indexOf(APP_VER.released) === 0, win.from);

  console.log('===== ④ 在线资源可达性 =====');
  const apkResp = await page.request.get(BASE + 'download/PhyHPC-Monitor.apk');
  const body = await apkResp.body();
  console.log('   APK: http=' + apkResp.status() + ' size=' + body.length);
  check('APK 可访问且 200', apkResp.status() === 200, apkResp.status());
  // ⚠ 关键一致性断言：APK 包内的版本必须与 app_version.json 相同。
// 背景（2026-10-19）：v1.1.3 的发布提交只改了 CHANGELOG 和 APK，漏改 app_version.json ——
// 弹窗/版本记录仍显示上一版，且 App 端 checkUpdate() 读到旧 versionCode，
// 已装上一版的用户收不到更新提示。此前探针只比对「页面 vs JSON」，两边都旧照样通过，
// 故必须与 APK 包内实际版本交叉验证（构建脚本会把版本写进 assets/public/js/version.js）。
const apkVerJs = (() => {
  try {
    return require('child_process').execSync(`unzip -p "${APK_FILE}" assets/public/js/version.js`,
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { return ''; }
})();
const apkVer = (apkVerJs.match(/name:\s*'([^']+)',\s*code:\s*(\d+)/) || []);
check('APK 包内版本与 app_version.json 一致',
  apkVer[1] === APP_VER.versionName && Number(apkVer[2]) === Number(APP_VER.versionCode),
  `APK=${apkVer[1] || '?'}/${apkVer[2] || '?'} vs JSON=${APP_VER.versionName}/${APP_VER.versionCode}`);

check('APK 体积与产物一致（' + require('fs').statSync(APK_FILE).size + ' B）', body.length === require('fs').statSync(APK_FILE).size, body.length);
  const qrResp = await page.request.get(BASE + 'download/qrcode-app.png');
  check('二维码仍在（未重新生成也有效）', qrResp.status() === 200, qrResp.status());

  console.log('===== ⑤ 页面无 JS 报错 =====');
  console.log('   错误数: ' + errors.length);
  check('零 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n===== 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
