// ============================================================
// HPC 集群监控面板 - 主脚本
// 物理与光电工程学院
// ============================================================

// 数据源配置
// 数据来自本仓库 data/slurm.json（由集群端定时生成推送）
var DATA_URL = 'data/slurm.json';
var REFRESH_INTERVAL = 300000; // 页面轮询周期 5 分钟（数据由集群端 cron 生成：日间约 20 分钟/次，夜间约 2 小时/次）
var refreshTimer = null;
var lastData = null;
var lastRaw = ''; // 上次数据原文，用于内容未变化时跳过重渲染
var lastUpdatedStr = '--'; // 最近一次成功获取的数据时间，供刷新失败提示使用
var lastUpdatedRaw = '';   // 同上，但保留原始字符串（形如 2026-10-15 10:40:04），
                           // 供排队等待时长计算做基准；不可用浏览器本地时间，
                           // 否则跨时区或本机时钟有偏差时会算错。
var _dataWarn = false;     // 当前是否处于「刷新失败」状态
var _clockTimer = null;    // 本地时钟定时器（每秒走动）

// ============================================================
// 工具函数
// ============================================================

function $(id) {
  return document.getElementById(id);
}

function esc(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 统一 SVG 图标渲染（依赖 index.html 内联 symbol 精灵）
function ic(name, cls) {
  return '<svg class="ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#ic-' + name + '"></use></svg>';
}

function pct(a, b) {
  return b > 0 ? Math.round(a / b * 100) : 0;
}

function barClass(p) {
  return p < 50 ? 'bar-green' : p < 80 ? 'bar-orange' : 'bar-red';
}

function tagState(s) {
  s = (s || '').toLowerCase();
  if (s === 'running') return '<span class="tag tag-run">运行中</span>';
  if (s === 'pending') return '<span class="tag tag-pend">等待中</span>';
  if (s.includes('down') || s.includes('drain')) return '<span class="tag tag-down">异常</span>';
  if (s === 'idle') return '<span class="tag tag-idle">空闲</span>';
  if (s === 'mixed') return '<span class="tag tag-mixed">混合</span>';
  if (s === 'alloc') return '<span class="tag tag-alloc">已分配</span>';
  return '<span class="tag">' + esc(s) + '</span>';
}

// 空数据占位卡（与"暂无告警"保持同一模式）
function sectionEmpty(iconName, id, titleText, emptyText) {
  return '<div class="section-title" id="' + id + '">' + ic(iconName) + ' ' + esc(titleText) + '</div>' +
         '<div class="card empty-state">' + esc(emptyText) + '</div>';
}

// ============================================================
// 侧边栏控制
// ============================================================

function toggleSidebar() {
  var sb = $('sidebar');
  var isMobile = window.innerWidth <= 1024;
  if (isMobile) {
    sb.classList.toggle('open');
  } else {
    var wrap = $('mainWrap');
    var ft = $('footer');
    sb.classList.toggle('hidden');
    wrap.classList.toggle('full');
    ft.classList.toggle('full');
  }
}

// 移动端导航点击后自动关闭侧边栏（仅初始化一次）
var _navCloseInited = false;

function initSidebarNavClose() {
  if (_navCloseInited) return;
  _navCloseInited = true;
  document.querySelectorAll('.sidebar-nav a').forEach(function (a) {
    a.addEventListener('click', function () {
      if (window.innerWidth <= 1024) {
        setTimeout(function () { $('sidebar').classList.remove('open'); }, 300);
      }
    });
  });
}

// ============================================================
// 回到顶部按钮
// ============================================================

// 顶栏收起/展开采用「迟滞阈值」：
//   下滚超过 HEADER_DOWN 才收起，回滚低于 HEADER_UP 才展开。
// 两者留出足够间隙，避免手指停在临界点附近时因 ±几 px 抖动来回切换。
//（注意：光有迟滞不够，还必须让顶栏用 fixed 脱离文档流，见 css/style.css 说明）
var HEADER_DOWN = 140;
var HEADER_UP = 80;
var _headerCollapsed = false;

// 在「瞬时状态」下测量顶栏高度。
// 直接加/删 .scrolled 后立刻读 offsetHeight 会拿到过渡动画的起点值
//（实测把 55px 读成 185px），故统一走 .measuring —— 它连同后代一起禁用 transition。
function dispatchMeasure(hd, mutate) {
  hd.classList.add('measuring');
  mutate();
  var h = hd.offsetHeight;   // 强制同步布局，此时过渡已被禁用
  hd.classList.remove('measuring');
  return h;
}

// 顶栏为 fixed，脱离文档流后由 .header-spacer 顶住原位置。
// 展开高度随断点字号与文案换行变化，需实测后写入占位块；
// 占位高度固定 => 顶栏收起不改变文档总高度 => 不会出现「收起->文档变矮->
// 滚动锚定补偿 scrollY->跌破阈值->展开」的自激振荡。
function syncHeaderSpacer() {
  var hd = document.querySelector('.header');
  var sp = document.querySelector('.header-spacer');
  if (!hd || !sp) return;
  var had = hd.classList.contains('scrolled');
  var natural = dispatchMeasure(hd, function () {
    if (had) hd.classList.remove('scrolled');   // 量展开态自然高度
  });
  if (natural > 0) sp.style.height = natural + 'px';
}

var _backTopTimer = null;
window.addEventListener('scroll', function () {
  if (_backTopTimer) return;
  _backTopTimer = requestAnimationFrame(function () {
    var btn = $('backTop');
    if (btn) {
      if (window.scrollY > 300) btn.classList.add('show');
      else btn.classList.remove('show');
    }
    // 顶栏滚动态：迟滞判定，模拟用户的"意图"而不是死盯单行像素阈值
    var hd = document.querySelector('.header');
    if (hd) {
      if (!_headerCollapsed && window.scrollY > HEADER_DOWN) _headerCollapsed = true;
      else if (_headerCollapsed && window.scrollY < HEADER_UP) _headerCollapsed = false;
      hd.classList.toggle('scrolled', _headerCollapsed);
    }
    _backTopTimer = null;
  });
}, { passive: true });

// ============================================================
// 侧边栏滚动高亮 + 平滑滚动（仅初始化一次）
// ============================================================

var _sidebarInited = false;

// 顶部栏现为常驻（position:fixed），会覆盖正文顶部约一行高度。
// 侧栏锚点跳转与滚动高亮都必须避开它，否则标题会被压在栏下看不见。
// 高度随断点字号变化，故每次实时读取而非缓存。
function stickyHeaderH() {
  var h = document.querySelector('.header');
  return h ? h.offsetHeight : 0;
}

// 顶栏「收起后」的高度（仅剩更新时间徽标那一行的高度）。
// 锚点要用它来算偏移：跳转的起点通常是展开态，但滚过去之后顶栏会收起，
// 若按当前（展开）高度做偏移，标题会离顶栏多出 150px 左右的空白。
// 这里用「加类-测量-还原」的方式实测，避免在 CSS 里硬编码高度。
function collapsedHeaderH() {
  var hd = document.querySelector('.header');
  if (!hd) return 0;
  var had = hd.classList.contains('scrolled');
  return dispatchMeasure(hd, function () {
    if (!had) hd.classList.add('scrolled');
  });
}

function initSidebarScroll() {
  if (_sidebarInited) return;
  _sidebarInited = true;

  var links = document.querySelectorAll('.sidebar-nav a');
  var sections = [];
  links.forEach(function (a) {
    var id = a.getAttribute('data-section');
    var el = document.getElementById(id);
    if (el) sections.push({ id: id, el: el, link: a });
  });

  var scrollTimer = null;
  window.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = requestAnimationFrame(function () {
      var cur = sections[0];
      var line = stickyHeaderH() + 8;   // 高亮判定线置于吸顶栏下沿
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].el.getBoundingClientRect().top <= line) cur = sections[i];
      }
      // 滚动到页面底部时直接高亮最后一节（替代原先靠 40vh 底部留白实现的效果）
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        cur = sections[sections.length - 1];
      }
      links.forEach(function (a) { a.classList.remove('active'); });
      if (cur) cur.link.classList.add('active');
      scrollTimer = null;
    });
  }, { passive: true });

  links.forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (!a.getAttribute('data-section')) return; // 不拦截外部链接
      e.preventDefault();
      var el = document.getElementById(a.getAttribute('data-section'));
      // 减去吸顶栏高度，保证目标标题落在栏目下沿而非被遮住
      if (el) {
        var ch = collapsedHeaderH();
        // 预估落点：若滚动后仍处于 HEADER_DOWN 以下，顶栏届时是收起态，按收起高度算偏移；
        // 否则目标就在页面顶部附近，顶栏保持展开，按展开高度算。
        var guessExpand = el.offsetTop - stickyHeaderH() - 12;
        var willCollapse = (el.offsetTop - ch - 12) > HEADER_DOWN;
        window.scrollTo({
          top: willCollapse ? el.offsetTop - ch - 12 : guessExpand,
          behavior: 'smooth'
        });
      }
    });
  });
}

// ============================================================
// 渲染面板数据
// ============================================================

// 进度条 HTML（含无障碍属性）
function progressBar(p) {
  return '<div class="progress" role="progressbar" aria-valuenow="' + p + '" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar ' + barClass(p) + '" style="width:' + p + '%"></div></div>';
}

function renderHeader(d) {
  var ov = d.overview || {};
  var ci = d.cluster_info || {};
  // 集群名称直接使用数据源字段（名称规范化已在集群端 data_collector.py 中完成）
  $('clusterName').textContent = ci.name || 'HPC 集群监控面板';
  $('clusterSub').textContent = 'Slurm ' + (ov.slurm_version || 'N/A') + ' · 运行时间 ' + (ov.server_uptime || 'N/A');
  $('updateTime').textContent = '最后更新: ' + (ov.last_updated || '--');
}

function renderOverview(d) {
  var ov = d.overview || {};
  var cs = ov.current_status || {};
  var jobs = ov.jobs || {};
  var us = ov.users || {};
  var h = [];
  h.push('<div class="section-title" id="overview">' + ic('overview') + ' 集群概览</div>');
  h.push('<div class="grid grid-4">');
  h.push('<div class="card stat"><div class="num">' + (cs.total_cores || 0) + '</div><div class="label">总核心数</div></div>');
  h.push('<div class="card stat green"><div class="num">' + (cs.allocated_cores || 0) + '</div><div class="label">已使用核心</div></div>');
  h.push('<div class="card stat cyan"><div class="num">' + (cs.free_cores || 0) + '</div><div class="label">空闲核心</div></div>');
  h.push('<div class="card stat ' + (jobs.running > 0 ? 'green' : '') + '"><div class="num">' + (jobs.running || 0) + '</div><div class="label">运行任务</div></div>');
  h.push('</div>');
  h.push('<div class="grid grid-4 mt-md">');
  h.push('<div class="card stat"><div class="num">' + (cs.active_nodes || 0) + '/' + (cs.total_nodes || 0) + '</div><div class="label">活跃节点</div></div>');
  h.push('<div class="card stat orange"><div class="num">' + (jobs.pending || 0) + '</div><div class="label">等待任务</div></div>');
  h.push('<div class="card stat"><div class="num">' + (us.online_terminal || 0) + '</div><div class="label">当前在线人数</div></div>');
  h.push('<div class="card stat ' + (cs.cpu_utilization_percent > 80 ? 'orange' : '') + '"><div class="num">' + (cs.cpu_utilization_percent || 0) + '%</div><div class="label">CPU 利用率</div></div>');
  h.push('</div>');
  return h.join('');
}

function renderPartitions(d) {
  var parts = d.partitions || [];
  var h = [];
  if (parts.length === 0) return sectionEmpty('partitions', 'partitions', '分区资源', '暂无分区数据');
  h.push('<div class="section-title" id="partitions">' + ic('partitions') + ' 分区资源</div>');
  h.push('<div class="grid grid-' + Math.min(Math.max(parts.length, 1), 3) + '">');
  parts.forEach(function (p) {
    var ac = p.allowed_cores || 960;
    var uc = p.allocated_cores || 0;
    var fc = p.free_cores || ac;
    var pp = pct(uc, ac);
    var pname = String(p.name || '未命名');
    pname = pname.charAt(0).toUpperCase() + pname.slice(1);
    h.push('<div class="card"><div class="card-title"><span class="dot"></span>' + esc(pname) + ' 分区 <span class="tag tag-qos">QOS: ' + esc(p.qos) + '</span></div>');
    h.push('<div class="progress-wrap"><div class="progress-label"><span>已使用 ' + uc + ' 核</span><span>' + pp + '%</span></div>' + progressBar(pp) + '</div>');
    h.push('<div class="kv-row"><span>允许核心: ' + ac + '</span><span>空闲: ' + fc + '</span></div>');
    h.push('<div class="sub-text">节点数: ' + (p.nodes || []).length + '</div></div>');
  });
  h.push('</div>');
  return h.join('');
}

function renderAlerts(d) {
  var alerts = d.alerts || {};
  var alertList = alerts.alerts || [];
  var h = [];
  if (alertList.length > 0) {
    h.push('<div class="section-title" id="alerts">' + ic('alerts') + ' 告警信息</div><div class="card">');
    alertList.forEach(function (a) {
      var icon = a.level === 'critical'
        ? ic('critical', 'alert-ic-critical')
        : ic('warning', 'alert-ic-warning');
      h.push('<div class="alert-item ' + (a.level === 'critical' ? 'alert-critical' : 'alert-warning') + '"><span class="alert-icon">' + icon + '</span><div><strong>' + esc(a.type) + '</strong> - ' + esc(a.message) + '<br><small class="sub-text">' + esc(a.timestamp) + '</small></div></div>');
    });
    h.push('</div>');
  } else {
    h.push('<div class="section-title" id="alerts">' + ic('alerts') + ' 告警信息</div><div class="card empty-state">✅ 暂无告警</div>');
  }
  return h.join('');
}

function renderDisks(d) {
  var disks = d.disks || [];
  var h = [];
  if (disks.length === 0) return sectionEmpty('disks', 'disks', '磁盘空间', '暂无磁盘数据');
  h.push('<div class="section-title" id="disks">' + ic('disks') + ' 磁盘空间</div>');
  h.push('<div class="grid grid-' + Math.min(Math.max(disks.length, 1), 4) + '">');
  disks.forEach(function (dk) {
    var p = dk.usage_percent || 0;
    h.push('<div class="card"><div class="card-title"><span class="dot" style="background:' + (dk.is_alert ? 'var(--danger)' : 'var(--success)') + '"></span>' + esc(dk.mount) + '</div>');
    h.push('<div class="progress-wrap"><div class="progress-label"><span>' + (dk.used_gb || 0) + 'GB / ' + (dk.total_gb || 0) + 'GB</span><span>' + p + '%</span></div>' + progressBar(p) + '</div>');
    h.push('<div class="sub-text">可用: ' + (dk.avail_gb || 0) + 'GB</div></div>');
  });
  h.push('</div>');
  return h.join('');
}

// ============================================================
// 排队原因说明
// ------------------------------------------------------------
// Slurm 官方 reason 码有 100+ 项，绝大多数涉及 Burst Buffer / GRES / License
// 等本集群未启用的功能，全部搬运只会淹没真正有用的信息。
// 故只收录两类：
//   ① seen:true  —— 本集群历史数据（351 份快照）中实际出现过的 4 种
//   ② seen:false —— 依本集群配置与常见用法判断的高概率原因 6 种
// mode 表示排队能否自行解决：auto=会自动开始 / manual=必须自己改
//
// 阈值**不写死在文案里**：卡片的括号数字由 qosLimitText() 在渲染时从
// data/slurm.json 的 constraints.partition_constraints 实时读取（该字段由
// collector 每轮跑 `sacctmgr show qos -P` 现采现写）。管理员调整 QOS 后，
// 卡片数字与上方阈值表会一起变，不会出现「上面 128、下面还写 96」的自相矛盾。
// 每一项用 dyn 指明取哪个字段，不再有需要人工同步的数字。
// ============================================================

// QOS 与分区一一对应，且一个 QOS 下挂着该分区的全体成员（实测 sacctmgr，见
// data/slurm.json 的 constraints.partition_constraints）——不是「一人一组」：
//   student → QOS student1（GrpTRES 384 / MaxTRESPerUser 96 / MaxTRESPerJob 48）
//   teacher → QOS teacher （GrpTRES 528 / MaxTRESPerUser 144 / MaxTRESPerJob 96）
//   test    → QOS test    （GrpTRES 144 / MaxTRESPerUser 48 / MaxTRESPerJob 48）
// 三个字段对应的 reason 码互相独立，别混：
//   GrpTRES         → QOSGrpCpuLimit        全分区合计，别人跑完就轮到你 → 会自动
//   MaxTRESPerUser  → QOSMaxCpuPerUserLimit 你自己累计，自己别的作业跑完 → 会自动
//   MaxTRESPerJob   → QOSMaxCpuPerJobLimit  单作业申请超限，Slurm 不会自动
//                                            降规格，等多久都不会开始 → 须自己改
var REASON_INFO = [
  { code: 'AssocMaxJobsLimit', seen: true, mode: 'auto',
    desc: '账号运行中作业数达上限' },

  // dyn 指定阈值取哪个字段；GrpTRES=分区合计 / MaxTRESPerUser=单人合计 /
  // MaxTRES=单人单作业。三个字段在 Slurm 里互相独立，别混
  { code: 'QOSGrpCpuLimit', seen: true, mode: 'auto', dyn: 'GrpTRES',
    desc: '本分区所有用户核数合计达上限' },

  { code: 'QOSMaxCpuPerUserLimit', seen: true, mode: 'auto', dyn: 'MaxTRESPerUser',
    desc: '你个人占用核数达上限' },

  { code: 'QOSMaxCpuPerJobLimit', seen: true, mode: 'manual', dyn: 'MaxTRES',
    desc: '单作业申请核数超上限，须自行减少' },

  // dynCluster：括号里是集群总核数，同样实时读取（扩机器后不用改代码）
  { code: 'Resources', seen: false, mode: 'auto', dynCluster: true,
    desc: '集群暂无满足申请的空闲资源' },

  { code: 'Priority', seen: false, mode: 'auto',
    desc: '有更高优先级的作业在前' }
];

// 把 "cpu=384" / "384" / "cpu=384,mem=1T" 统一解析成 "384"；解析不出返回 ''
function qosCpuNum(v) {
  var s = String(v == null ? '' : v);
  var m = s.match(/cpu\s*=\s*(\d+)/i);
  if (m) return m[1];
  m = s.match(/^\s*(\d+)\s*$/);
  return m ? m[1] : '';
}

// 按 partition_constraints 的**数组顺序**抽出各分区阈值，拼成 "384/528/144"。
// 顺序与上方「各分区 QOS 阈值」表同源（同一个数组），故两者天然对齐；QOS 一改两处一起变。
// 任一分区缺该字段即整体返回 ''（宁可不显示，也不显示缺项错位的数字）。
function qosLimitText(d, field) {
  var cp = (d && d.constraints && d.constraints.partition_constraints) || [];
  if (!cp.length || !field) return '';
  var vals = [];
  for (var i = 0; i < cp.length; i++) {
    var n = qosCpuNum(cp[i][field]);
    if (!n) return '';
    vals.push(n);
  }
  return vals.join('/');
}

// 集群总核数（「Resources」卡括号里那句）同样不写死 —— 加机器后自动跟随。
// 优先取 constraints.cluster_shared_resources，回退到 overview.fixed_config。
function clusterCoresText(d) {
  var v = '';
  var cs = d && d.constraints && d.constraints.cluster_shared_resources;
  if (cs && cs.total_cores) v = cs.total_cores;
  else if (d && d.overview && d.overview.fixed_config) v = d.overview.fixed_config.total_cores;
  v = String(v == null ? '' : v);
  return /^\d+$/.test(v) ? (v + ' 核共用') : '';
}

// 从 squeue 的 reason 字段里抽出原因码。
// Slurm 原样输出的形态是 (AssocMaxJobsLimit)，少数情况会有多个或为空。
function parseReasonCodes(raw) {
  var out = [];
  var re = /\(([^()]+)\)/g;
  var m;
  while ((m = re.exec(raw || '')) !== null) out.push(m[1]);
  if (out.length === 0) {
    var s = (raw || '').trim();
    if (s && s !== 'N/A') out.push(s);
  }
  return out;
}

function findReasonInfo(code) {
  for (var i = 0; i < REASON_INFO.length; i++) {
    if (REASON_INFO[i].code === code) return REASON_INFO[i];
  }
  return null;
}

// 从「排队原因」板块跳到任务列表：滚动到第一条因该原因等待的作业，并高亮全部命中行。
// 原因码由 parseReasonCodes 解析，与实况统计口径一致（一个作业的 reason 可能是复合串）。
var _rowHitTimer = null;
function jumpToPendingTasks(code) {
  var table = document.getElementById('jobTable');
  if (!table || !code) return false;
  var rows = [].slice.call(table.querySelectorAll('tbody tr[data-status="PENDING"]'));
  var hits = rows.filter(function (tr) {
    return parseReasonCodes(tr.getAttribute('data-reason')).indexOf(code) >= 0;
  });
  if (hits.length === 0) {
    // 任务超过 50 条时表格尾部会被截断，命中行可能不在其中 —— 退化为跳到任务列表标题
    var sect = document.getElementById('jobs');
    if (sect) {
      var ch0 = collapsedHeaderH();
      var guess0 = sect.offsetTop - stickyHeaderH() - 12;
      var will0 = (sect.offsetTop - ch0 - 12) > HEADER_DOWN;
      window.scrollTo({ top: Math.max(0, will0 ? sect.offsetTop - ch0 - 12 : guess0), behavior: 'smooth' });
    }
    return false;
  }

  // 落点偏移：滚动后仍处于 HEADER_DOWN 以下则顶栏是收起态（同侧栏锚点算法），
  // 再减去表头高度，避免目标行被「顶栏 + 表头」双重遮挡。
  var thead = table.tHead ? table.tHead.offsetHeight : 0;
  var ch = collapsedHeaderH();
  var targetDocTop = hits[0].getBoundingClientRect().top + window.scrollY;
  var willCollapse = (targetDocTop - ch - thead - 12) > HEADER_DOWN;
  var top = targetDocTop - (willCollapse ? ch : stickyHeaderH()) - thead - 12;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });

  // 高亮：先清掉上一轮，再给本轮命中行打标；2.4 秒后自动褪去
  [].slice.call(table.querySelectorAll('tr.row-hit')).forEach(function (tr) { tr.classList.remove('row-hit'); });
  hits.forEach(function (tr) { tr.classList.add('row-hit'); });
  if (_rowHitTimer) clearTimeout(_rowHitTimer);
  _rowHitTimer = setTimeout(function () {
    hits.forEach(function (tr) { tr.classList.remove('row-hit'); });
    _rowHitTimer = null;
  }, 2400);
  return true;
}

// 「排队原因」板块的点击委托（只绑一次；板块随 render 重建，故不能用直接绑定）
var _reasonJumpInited = false;
function initReasonJump() {
  if (_reasonJumpInited) return;
  _reasonJumpInited = true;
  document.addEventListener('click', function (e) {
    var t = e.target;
    var el = t && t.closest ? t.closest('[data-jump-reason]') : null;
    if (!el) return;
    e.preventDefault();
    jumpToPendingTasks(el.getAttribute('data-jump-reason'));
  });
}

// 等待时长格式化
function fmtWait(ms) {
  var min = Math.floor(ms / 60000);
  if (min < 1) return '不足 1 分钟';
  if (min < 60) return min + ' 分钟';
  var h = Math.floor(min / 60), mm = min % 60;
  if (h < 24) return mm ? (h + ' 小时 ' + mm + ' 分') : (h + ' 小时');
  var d = Math.floor(h / 24), hh = h % 24;
  return hh ? (d + ' 天 ' + hh + ' 小时') : (d + ' 天');
}

// 用 last_updated 而非浏览器本地时间作为「现在」，避免时区或
// 浏览器时钟偏差导致等待时长算错。last_updated 形如 2026-10-15 10:40:04。
function dataNowMs() {
  if (!lastUpdatedRaw) return null;
  var t = Date.parse(lastUpdatedRaw.replace(' ', 'T'));
  return isNaN(t) ? null : t;
}

function renderPendingReasons(d) {
  var jobs = d.jobs || [];
  var pending = jobs.filter(function (j) { return j.status === 'PENDING'; });
  var h = [];

  h.push('<div class="reason-block">');
  h.push('<div class="card-title"><span class="dot"></span>排队原因速查</div>');

  // ---- ① 当前实况 ----
  var now = dataNowMs();
  var stat = [];
  pending.forEach(function (j) {
    parseReasonCodes(j.reason).forEach(function (code) {
      var rec = null;
      for (var i = 0; i < stat.length; i++) if (stat[i].code === code) rec = stat[i];
      if (!rec) { rec = { code: code, count: 0, maxWait: 0 }; stat.push(rec); }
      rec.count++;
      var w = (now && j.submit_time) ? (now - Date.parse(String(j.submit_time).replace(' ', 'T'))) : NaN;
      if (!isNaN(w) && w > rec.maxWait) rec.maxWait = w;
    });
  });
  stat.sort(function (a, b) { return b.count - a.count; });

  h.push('<div class="reason-live">');
  if (stat.length === 0) {
    h.push('<span class="reason-live-empty">当前没有作业在排队，以下原因供参考。</span>');
  } else {
    stat.forEach(function (s) {
      var known = !!findReasonInfo(s.code);
      // 每个实况标签都可点击：直接跳到任务列表里因此原因等待的作业
      h.push('<span class="reason-live-chip is-jump' + (known ? '' : ' is-unknown') + '"'
        + ' data-jump-reason="' + esc(s.code) + '" title="点击定位到任务列表中等待的作业">'
        + esc('(' + s.code + ')') + ' ×' + s.count
        + (known ? '' : '<span class="rw">未收录</span>')
        + (s.maxWait > 0 ? '<span class="rw">最长已等 ' + esc(fmtWait(s.maxWait)) + '</span>' : '')
        + '</span>');
    });
  }
  h.push('</div>');

  // ---- ② 原因速查（卡片网格：一条一张卡，一律两行；宽屏两列、窄屏一列） ----
  h.push('<div class="reason-grid">');
  REASON_INFO.forEach(function (r) {
    var live = null;
    for (var i = 0; i < stat.length; i++) if (stat[i].code === r.code) live = stat[i];
    // 正在排队的卡片整卡可点击，点击后定位到任务列表里对应的等待作业。
    // 属性分开拼：class 值走变量、额外属性走 trAttr，避免手写引号时漏掉闭合引号
    //（曾写成 '<tr class="' + ... + '>'，class 值未闭合，浏览器把随后的
    //  '><td class="rc">' 整个吞进 class 属性里，导致原因码单元格消失）
    var cls = 'rg-card' + (r.mode === 'manual' ? ' is-manual' : '') + (live ? ' is-live is-jump' : '');
    var attr = live ? ' data-jump-reason="' + esc(r.code) + '" title="点击定位到任务列表中等待的作业"' : '';
    h.push('<div class="' + cls + '"' + attr + '>');
    // 第一行：原因码 + 标签 + 处置方式（右端贴齐）；第二行：含义。
    // 标签位只放一枚 —— 「常见」与「排队中」并排时首行会在 1024 宽度下被挤到
    // 换行，卡片就变成三行。正在排队时「排队中」比「常见」信息量更大，故优先。
    h.push('<div class="rg-top">');
    h.push('<span class="reason-code">' + esc('(' + r.code + ')') + '</span>');
    if (live) h.push('<span class="tag tag-live rg-live-tag">排队中 ↓</span>');
    else if (r.seen) h.push('<span class="tag tag-seen">常见</span>');
    h.push('<span class="rg-mode ' + (r.mode === 'auto' ? 'auto' : 'manual') + '">'
      + (r.mode === 'auto' ? '会自动' : '须自己改') + '</span>');
    h.push('</div>');
    // 括号里的阈值实时读自 constraints（dyn=QOS 字段 / dynCluster=集群总核数）；
    // 数据缺失就不显示括号，宁可留白也不写一个可能与服务器不符的数字
    var lim = r.dyn ? qosLimitText(d, r.dyn) : (r.dynCluster ? clusterCoresText(d) : '');
    h.push('<div class="rg-desc">' + esc(r.desc) + (lim ? '（' + esc(lim) + '）' : '') + '</div>');
    h.push('</div>');
  });
  h.push('</div>');

  // 一个作业可能同时撞上多条限制，Slurm 只报「调度尝试中最先遇到的那一个」
  //（官方 job_reason_codes 原文：only the reason that was encountered by the
  // attempted scheduling method will be displayed）。实测本集群 job 30801 申请
  // 96 核（student1 单作业上限 48）却报 QOSGrpCpuLimit —— 标「会自动」的码
  // 未必真能等到，故提醒用户回头核一下申请核数。
  // 与卡片同源：句中的单作业上限同样实时读取，避免这里漏改
  var jobLim = qosLimitText(d, 'MaxTRES');
  h.push('<div class="sub-text sm">'
    + '运行中作业该列显示的是<strong>节点名</strong>，非等待原因；未收录的原因码会标红显示。'
    + '一个作业可能同时被多条限制拦住，此处只显示 Slurm <strong>最先遇到</strong>的那一个 —— '
    + '标「会自动」的原因仍建议核对申请核数是否超过单作业上限'
    + (jobLim ? '（' + esc(jobLim) + '）' : '') + '。'
    + '</div>');
  h.push('</div>');
  return h.join('');
}

function renderQos(d) {
  var con = d.constraints || {};
  var cp = con.partition_constraints || [];
  var h = [];
  // 即使 QOS 约束表为空也要渲染板块 —— 排队原因说明不依赖 QOS 数据，
  // 且它本身是有价值的常备内容。
  if (cp.length === 0 && (d.jobs || []).length === 0) return '';
  h.push('<div class="section-title" id="qos">' + ic('qos') + ' QOS 约束与排队原因</div>');
  h.push('<div class="card">');
  if (cp.length > 0) {
    h.push('<div class="card-title"><span class="dot"></span>各分区 QOS 阈值</div>');
    h.push('<div class="table-wrap"><table><thead><tr><th>分区</th><th>QOS</th><th>GrpTRES<br><small style="font-weight:400;color:var(--text2)">分区最大总资源</small></th><th>MaxTRES<br><small style="font-weight:400;color:var(--text2)">单任务最大资源</small></th><th>MaxTRESPerUser<br><small style="font-weight:400;color:var(--text2)">用户最大资源</small></th></tr></thead><tbody>');
    cp.forEach(function (c) {
      h.push('<tr><td><strong>' + esc(c.partition) + '</strong></td><td><span class="tag tag-qos">' + esc(c.qos_name) + '</span></td><td>' + esc(c.GrpTRES) + '</td><td>' + esc(c.MaxTRES) + '</td><td>' + esc(c.MaxTRESPerUser) + '</td></tr>');
    });
    h.push('</tbody></table></div>');
  }
  h.push(renderPendingReasons(d));
  h.push('</div>');
  return h.join('');
}

function renderNodes(d) {
  var nodes = d.nodes || [];
  var h = [];
  if (nodes.length === 0) return sectionEmpty('nodes', 'nodes', '节点状态', '暂无节点数据');
  h.push('<div class="section-title" id="nodes">' + ic('nodes') + ' 节点状态</div><div class="card"><div class="node-grid">');
  nodes.forEach(function (n) {
    var s = (n.state || '').toLowerCase();
    var bg = 'rgba(79,110,247,.05)';
    if (s === 'idle') bg = 'rgba(6,182,212,.08)';
    else if (s === 'mixed') bg = 'rgba(245,158,11,.08)';
    else if (s === 'alloc') bg = 'rgba(34,197,94,.08)';
    else if (s.includes('down') || s.includes('drain')) bg = 'rgba(239,68,68,.08)';
    var u = n.users || [];
    h.push('<div class="node-chip" style="background:' + bg + '"><div class="n-name">' + esc(n.name) + '</div><div class="n-state">' + tagState(n.state) + '</div><div class="sub-text sm">' + (n.allocated_cores || 0) + '/' + (n.total_cores || 0) + '核 · ' + (n.jobs_running || 0) + '任务</div>' + (u.length ? '<div class="sub-text sm">' + u.map(esc).join(', ') + '</div>' : '') + '</div>');
  });
  h.push('</div></div>');
  return h.join('');
}

function renderJobs(d) {
  var jlist = d.jobs || [];
  var h = [];
  var runJobs = jlist.filter(function (j) { return j.status === 'RUNNING'; });
  var pendJobs = jlist.filter(function (j) { return j.status === 'PENDING'; });
  if (jlist.length > 0) {
    h.push('<div class="section-title" id="jobs">' + ic('jobs') + ' 任务列表 <small style="color:var(--text2);font-weight:400">(' + runJobs.length + ' 运行, ' + pendJobs.length + ' 等待)</small></div>');
    h.push('<div class="card"><div class="table-wrap"><table id="jobTable"><thead><tr><th>Job ID</th><th>名称</th><th>状态</th><th>分区</th><th>用户</th><th>CPU</th><th>运行时间</th><th>时限</th><th>原因</th></tr></thead><tbody>');
    jlist.slice(0, 50).forEach(function (j) {
      // data-reason 供「排队原因」板块点击跳转时定位；运行中作业该字段是节点名，不参与匹配
      h.push('<tr data-status="' + esc(j.status) + '" data-reason="' + esc(j.reason) + '"><td>' + esc(j.job_id) + '</td><td>' + esc(j.name) + '</td><td>' + tagState(j.status) + '</td><td>' + esc(j.partition) + '</td><td>' + esc(j.user) + '</td><td>' + (j.cpus || 0) + '</td><td>' + esc(j.runtime) + '</td><td>' + esc(j.time_limit) + '</td><td class="cell-ellipsis" title="' + esc(j.reason) + '">' + esc(j.reason) + '</td></tr>');
    });
    if (jlist.length > 50) h.push('<tr><td colspan="9" style="text-align:center;color:var(--text2)">... 仅显示前 50 条，共 ' + jlist.length + ' 条</td></tr>');
    h.push('</tbody></table></div></div>');
  } else {
    h.push(sectionEmpty('jobs', 'jobs', '任务列表', '当前无任务'));
  }
  return h.join('');
}

function renderUsers(d) {
  var ulist = d.users || [];
  var h = [];
  if (ulist.length > 0) {
    h.push('<div class="section-title" id="users">' + ic('users') + ' 用户资源</div>');
    h.push('<div class="card"><div class="table-wrap"><table><thead><tr><th>用户</th><th>运行</th><th>等待</th><th>核心</th><th>节点</th><th>分区</th><th>在线</th></tr></thead><tbody>');
    ulist.forEach(function (u) {
      h.push('<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + (u.running_jobs || 0) + '</td><td>' + (u.pending_jobs || 0) + '</td><td>' + (u.total_cores || 0) + '</td><td>' + (u.total_nodes || 0) + '</td><td>' + (u.partitions || []).map(esc).join(', ') + '</td><td>' + (u.is_online ? '<span class="tag tag-online">在线</span>' : '<span style="color:var(--text2)">-</span>') + '</td></tr>');
    });
    h.push('</tbody></table></div></div>');
  } else {
    h.push(sectionEmpty('users', 'users', '用户资源', '当前无用户任务'));
  }
  return h.join('');
}

function renderOnline(d) {
  var online = d.online_users || [];
  var h = [];
  if (online.length > 0) {
    h.push('<div class="section-title" id="online">' + ic('online') + ' 在线终端</div>');
    h.push('<div class="card"><div class="table-wrap"><table><thead><tr><th>用户</th><th>终端</th><th>来源</th><th>登录时间</th><th>空闲</th><th>会话数</th></tr></thead><tbody>');
    online.forEach(function (u) {
      h.push('<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + esc(u.tty) + '</td><td>' + esc(u.from) + '</td><td>' + esc(u.login_time) + '</td><td>' + esc(u.idle) + '</td><td>' + (u.sessions || 1) + '</td></tr>');
    });
    h.push('</tbody></table></div></div>');
  } else {
    h.push(sectionEmpty('online', 'online', '在线终端', '当前无在线终端会话'));
  }
  return h.join('');
}

// 更新策略栏目：静态内容（仅更新策略三枚信息），不依赖实时数据
function renderAnnouncement() {
  var h = [];
  h.push('<div class="section-title" id="announcement">' + ic('bullhorn') + ' 更新策略</div>');
  h.push('<div class="card announcement-card">');
  h.push('<div class="ann-strategy">');
  h.push('<div class="ann-pill"><span class="ann-pill-ico">☀️</span><div class="ann-pill-txt"><b>日间 08:00–24:00</b><span>每 20 分钟自动刷新</span></div></div>');
  h.push('<div class="ann-pill"><span class="ann-pill-ico">🌙</span><div class="ann-pill-txt"><b>夜间 00:00–08:00</b><span>每 2 小时自动刷新</span></div></div>');
  h.push('<div class="ann-pill"><span class="ann-pill-ico">🔄</span><div class="ann-pill-txt"><b>页面轮询</b><span>每 5 分钟核查最新</span></div></div>');
  h.push('</div>');
  h.push('</div>');
  return h.join('');
}

// 渲染入口：按分区拼装各区块（拆分自原 140 行巨型函数）
function render(d) {
  $('loader').style.display = 'none';
  renderHeader(d);
  $('app').innerHTML = [
    renderAnnouncement(),
    renderOverview(d),
    renderPartitions(d),
    renderAlerts(d),
    renderDisks(d),
    renderQos(d),
    renderNodes(d),
    renderJobs(d),
    renderUsers(d),
    renderOnline(d)
  ].join('');
  initSidebarScroll();
  initSidebarNavClose();
  // 副标题文案（Slurm 版本 · 运行时间）首次填充后可能换行改变顶栏高度，需重算占位
  syncHeaderSpacer();
}

// ============================================================
// 顶部时间条（数据时间 + 逐秒走动的本地时间）
// ------------------------------------------------------------
// 本地时间由独立的 1 秒时钟驱动。此前它只在请求返回时计算一次，
// 而页面轮询周期是 5 分钟，导致本地时间「五分钟才跳一次」。
// ============================================================

function renderTimeBar() {
  var ub = $('updateTime');
  if (!ub) return;
  var clock = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  ub.textContent = (_dataWarn ? '⚠ 刷新失败 · 上次成功: ' + lastUpdatedStr
                              : '最后更新: ' + lastUpdatedStr)
    + ' · 本地时间：' + clock;
  ub.classList.toggle('badge-warn', _dataWarn);
}

function startClock() {
  if (_clockTimer) return; // 避免前后台切换时堆积多个定时器
  renderTimeBar();
  _clockTimer = setInterval(renderTimeBar, 1000);
}

function stopClock() {
  if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
}

// ============================================================
// 数据获取（多源容错）
// ============================================================

function fetchData() {
  var ctrl = null;
  var tid = null;
  if (typeof AbortController !== 'undefined') {
    ctrl = new AbortController();
    tid = setTimeout(function () { ctrl.abort(); }, 10000);
  }

  // cache:'no-cache' 强制向服务器发条件请求（可命中 304），替代 ?t= 时间戳（后者完全绕过缓存）
  var opts = { cache: 'no-cache' };
  if (ctrl) opts.signal = ctrl.signal;

  fetch(DATA_URL, opts)
    .then(function (r) {
      if (tid) clearTimeout(tid);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (raw) {
      var changed = raw !== lastRaw;
      var d = JSON.parse(raw);
      // 这两个值必须在 render() 之前赋值：
      // renderPendingReasons() 要用 lastUpdatedRaw 作基准算排队等待时长，
      // 晚于 render 赋值会导致首屏等待时长全都不显示。
      lastUpdatedStr = (d.overview && d.overview.last_updated) || '--';
      lastUpdatedRaw = (d.overview && d.overview.last_updated) || '';
      if (changed) {
        lastRaw = raw;
        lastData = d;
        render(d); // 内容未变化时跳过重渲染，避免整页 DOM 重建
      }
      _dataWarn = false;
      renderTimeBar();
    })
    .catch(function (e) {
      if (tid) clearTimeout(tid);
      console.warn('数据加载失败:' + e.message);
      if (!lastData) {
        $('loader').innerHTML = '<div style="color:var(--danger)">❌ 数据加载失败<br><small>' + esc(e.message) + '</small></div>';
      } else {
        // 已有旧数据：不再静默，给出明确的刷新失败提示，避免用户看到陈旧数据而无感知
        _dataWarn = true;
        renderTimeBar();
      }
    });
}

// ============================================================
// 用户搜索
// ============================================================

var _searchTimer = null;

function searchUser(query) {
  var results = $('userSearchResults');
  if (!results) return;

  query = (query || '').trim().toLowerCase();
  if (!query) {
    results.classList.remove('show');
    results.innerHTML = '';
    return;
  }

  if (!lastData) {
    results.innerHTML = '<div class="search-no-result">数据加载中，请稍候...</div>';
    results.classList.add('show');
    return;
  }

  var ulist = lastData.users || [];
  var jlist = lastData.jobs || [];
  var online = lastData.online_users || [];

  var matched = ulist.filter(function (u) {
    return (u.username || '').toLowerCase().indexOf(query) !== -1;
  });

  if (matched.length === 0) {
    results.innerHTML = '<div class="search-no-result">未找到匹配的用户</div>';
    results.classList.add('show');
    return;
  }

  var h = [];

  matched.slice(0, 5).forEach(function (u) {
    var uname = u.username;

    // User info card
    h.push('<div class="search-result-user">');
    h.push('<div class="sr-username">' + esc(uname) + (u.is_online ? ' <span class="tag tag-online" style="font-size:.7rem;vertical-align:middle">在线</span>' : '') + '</div>');
    h.push('<div class="sr-info">');
    h.push('<span class="sr-tag">运行 ' + (u.running_jobs || 0) + '</span>');
    h.push('<span class="sr-tag">等待 ' + (u.pending_jobs || 0) + '</span>');
    h.push('<span class="sr-tag">' + (u.total_cores || 0) + ' 核</span>');
    h.push('<span class="sr-tag">' + (u.total_nodes || 0) + ' 节点</span>');
    h.push('<span class="sr-tag">' + (u.partitions || []).map(esc).join(', ') + '</span>');
    h.push('</div></div>');

    // User's jobs
    var userJobs = jlist.filter(function (j) { return j.user === uname; });
    if (userJobs.length > 0) {
      h.push('<div class="search-result-section"><h4>' + ic('jobs') + ' 任务 (' + userJobs.length + ')</h4>');
      h.push('<div class="table-wrap"><table><thead><tr><th>ID</th><th>名称</th><th>状态</th><th>CPU</th><th>运行时间</th></tr></thead><tbody>');
      userJobs.slice(0, 10).forEach(function (j) {
        h.push('<tr><td>' + esc(j.job_id) + '</td><td>' + esc(j.name) + '</td><td>' + tagState(j.status) + '</td><td>' + (j.cpus || 0) + '</td><td>' + esc(j.runtime) + '</td></tr>');
      });
      if (userJobs.length > 10) h.push('<tr><td colspan="5" style="text-align:center;color:var(--text2);font-size:.75rem">... 共 ' + userJobs.length + ' 条</td></tr>');
      h.push('</tbody></table></div></div>');
    }

    // User's online sessions
    var userOnline = online.filter(function (o) { return o.username === uname; });
    if (userOnline.length > 0) {
      h.push('<div class="search-result-section"><h4>' + ic('online') + ' 在线终端</h4>');
      h.push('<div class="table-wrap"><table><thead><tr><th>终端</th><th>来源</th><th>登录时间</th><th>空闲</th></tr></thead><tbody>');
      userOnline.forEach(function (o) {
        h.push('<tr><td>' + esc(o.tty) + '</td><td>' + esc(o.from) + '</td><td>' + esc(o.login_time) + '</td><td>' + esc(o.idle) + '</td></tr>');
      });
      h.push('</tbody></table></div></div>');
    }
  });

  if (matched.length > 5) {
    h.push('<div class="search-no-result" style="font-size:.78rem">还有 ' + (matched.length - 5) + ' 个匹配用户，请输入更精确的用户名</div>');
  }

  results.innerHTML = h.join('');
  results.classList.add('show');
}

function initUserSearch() {
  var input = $('userSearchInput');
  if (!input) return;

  // Create results div and append to body (avoids stacking context from .header's backdrop-filter)
  var results = document.createElement('div');
  results.className = 'user-search-results';
  results.id = 'userSearchResults';
  document.body.appendChild(results);

  function positionResults() {
    var rect = input.getBoundingClientRect();
    results.style.top = (rect.bottom + 6) + 'px';
    results.style.left = rect.left + 'px';
    results.style.width = rect.width + 'px';
  }

  input.addEventListener('input', function () {
    if (_searchTimer) clearTimeout(_searchTimer);
    var val = input.value;
    _searchTimer = setTimeout(function () {
      searchUser(val);
      if (results.classList.contains('show')) positionResults();
    }, 150);
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.user-search-wrap') && !e.target.closest('.user-search-results')) {
      results.classList.remove('show');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      results.classList.remove('show');
      input.blur();
    }
  });

  window.addEventListener('resize', function () {
    if (results.classList.contains('show')) positionResults();
  });

  // 结果框为 fixed 定位，页面滚动时需跟随输入框重定位，否则二者脱离
  window.addEventListener('scroll', function () {
    if (results.classList.contains('show')) positionResults();
  }, { passive: true });
}

// ============================================================
// 手机端 App 下载弹窗
// ============================================================

function initAppModal() {
  var modal = $('appModal');
  var entry = $('appDownloadEntry');
  if (!modal || !entry) return; // 页面未包含该模块时静默跳过

  function openModal() {
    modal.classList.add('show');
    document.body.classList.add('modal-open');
    // 移动端：弹窗会覆盖侧边栏，先收起避免叠层
    if (window.innerWidth <= 1024) $('sidebar').classList.remove('open');
  }

  function closeModal() {
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
  }

  // 入口：JS 可用时弹出二维码弹窗；JS 失效时 href 直接下载 APK（降级）
  entry.addEventListener('click', function (e) {
    e.preventDefault();
    openModal();
  });

  var closeBtn = $('appModalClose');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);

  // 点击遮罩空白区域关闭
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal();
  });

  // Esc 键关闭
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('show')) closeModal();
  });

  // 复制下载链接（取 a.href 的绝对地址，自动适配实际部署域名）
  var copyBtn = $('appCopyLink');
  var linkEl = $('apkDirectLink');
  if (copyBtn && linkEl) {
    copyBtn.addEventListener('click', function () {
      var url = linkEl.href;
      function done() {
        copyBtn.textContent = '已复制 ✓';
        setTimeout(function () { copyBtn.textContent = '复制下载链接'; }, 1800);
      }
      function fallbackCopy() {
        var ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { /* 复制失败时静默处理 */ }
        document.body.removeChild(ta);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, fallbackCopy);
      } else {
        fallbackCopy();
      }
    });
  }
}

// ============================================================
// 新版本提示弹窗（屏幕居中，显示 5 秒后自动收起，可手动关闭）
// ------------------------------------------------------------
// 【定时机制】弹窗只在下方 APP_NOTICE 设定的时间窗口内弹出，
//   未到生效时间或已过期都不会显示（弹窗节点仍保留在页面中，处于隐藏状态）。
//   —— 发布下一条通知时，只需改这个时间窗口 + index.html 里 #appNotice 的文案，
//      弹窗的显示、倒计时、关闭、跳转逻辑无需改动，可直接复用。
// ============================================================

var APP_NOTICE = {
  // 生效时间窗口。带时区偏移（+08:00）书写，避免不同设备解析出歧义
  from:  '2026-10-14T00:00:00+08:00',   // 开始显示
  until: '2026-10-21T23:59:59+08:00'    // 到期后自动失效（本次为发布后一周）
};

function initAppNotice() {
  var notice = $('appNotice');
  if (!notice) return; // 页面未包含该模块时静默跳过

  // 时间窗口判定：未生效或已过期则直接不显示
  var now = Date.now();
  var start = Date.parse(APP_NOTICE.from);
  var end = Date.parse(APP_NOTICE.until);
  if (!isNaN(start) && now < start) return;
  if (!isNaN(end) && now > end) return;

  var card = notice.querySelector('.notice-card');
  var secEl = $('appNoticeSec');
  var DURATION = 5000;   // 自动关闭时长
  var DELAY = 700;       // 首屏渲染后再弹出，避免抢注意力

  var openTimer = null, tickTimer = null, outTimer = null;
  var dismissed = false;

  // 关闭：先播放退场动画，再彻底隐藏并清理全部定时器
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    if (openTimer) clearTimeout(openTimer);
    if (tickTimer) clearInterval(tickTimer);
    if (secEl) secEl.textContent = '0';
    if (card) card.classList.add('out');
    outTimer = setTimeout(function () {
      notice.classList.remove('show');
      if (card) card.classList.remove('out');
    }, 260);
  }

  function show() {
    notice.classList.add('show');
    if (card) card.classList.remove('out');
    // 以绝对时间为准倒计时：即使后台标签页被节流，总时长依然准确
    var deadline = Date.now() + DURATION;
    function tick() {
      var left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      if (secEl) secEl.textContent = String(left);
      if (left <= 0) dismiss();
    }
    tick();
    tickTimer = setInterval(tick, 200);
  }

  var closeBtn = $('appNoticeClose');
  if (closeBtn) closeBtn.addEventListener('click', dismiss);

  // 点击遮罩空白区域关闭
  notice.addEventListener('click', function (e) {
    if (e.target === notice) dismiss();
  });

  // Esc 键关闭
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && notice.classList.contains('show')) dismiss();
  });

  // 「立即下载」：收起提示后打开二维码下载弹窗
  var goBtn = $('appNoticeGo');
  if (goBtn) goBtn.addEventListener('click', function () {
    dismiss();
    var entry = $('appDownloadEntry');
    if (entry) entry.click();
    else {
      var link = $('apkDirectLink');
      if (link) window.location.href = link.getAttribute('href');
    }
  });

  openTimer = setTimeout(show, DELAY);
}

// ============================================================
// 初始化
// ============================================================

// 静态按钮事件绑定（替代 HTML 内联 onclick，配合 CSP 收紧）
(function initStaticButtons() {
  var ids = ['sidebarClose', 'sidebarToggle', 'sidebarOverlay'];
  ids.forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('click', toggleSidebar);
  });
  var backTop = $('backTop');
  if (backTop) backTop.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

fetchData();
refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);
initUserSearch();
initAppModal();
initAppNotice();
initReasonJump();
startClock();
// 顶栏脱离文档流后需同步占位块高度（首次渲染时副标题文案尚未填充，
// 待数据回来后副标题换行可能导致高度变化，故此处与 render() 后各同步一次）
syncHeaderSpacer();

var _spacerResizeTimer = null;
window.addEventListener('resize', function () {
  if (_spacerResizeTimer) clearTimeout(_spacerResizeTimer);
  _spacerResizeTimer = setTimeout(syncHeaderSpacer, 150);
});

document.addEventListener('visibilitychange', function () {
  // 先无条件清掉既有定时器，避免前后台快速切换时堆积多个轮询
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (document.hidden) {
    stopClock(); // 后台停表，省电
  } else {
    fetchData();
    refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);
    startClock();
  }
});
