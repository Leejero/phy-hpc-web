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

var _backTopTimer = null;
window.addEventListener('scroll', function () {
  if (_backTopTimer) return;
  _backTopTimer = requestAnimationFrame(function () {
    var btn = $('backTop');
    if (btn) {
      if (window.scrollY > 300) btn.classList.add('show');
      else btn.classList.remove('show');
    }
    // 顶栏滚动态：下滚超过 120px 后收起标题/副标题/搜索框并转为半透明
    //（阈值不宜过小，否则轻微滚动就会触发收起/展开来回抖动）
    var hd = document.querySelector('.header');
    if (hd) hd.classList.toggle('scrolled', window.scrollY > 120);
    _backTopTimer = null;
  });
}, { passive: true });

// ============================================================
// 侧边栏滚动高亮 + 平滑滚动（仅初始化一次）
// ============================================================

var _sidebarInited = false;

// 顶部栏现为常驻吸顶（position:sticky），会覆盖正文顶部约一行高度。
// 侧栏锚点跳转与滚动高亮都必须避开它，否则标题会被压在栏下看不见。
// 高度随断点字号变化，故每次实时读取而非缓存。
function stickyHeaderH() {
  var h = document.querySelector('.header');
  return h ? h.offsetHeight : 0;
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
      if (el) window.scrollTo({ top: el.offsetTop - stickyHeaderH() - 12, behavior: 'smooth' });
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

function renderQos(d) {
  var con = d.constraints || {};
  var cp = con.partition_constraints || [];
  var h = [];
  if (cp.length > 0) {
    h.push('<div class="section-title" id="qos">' + ic('qos') + ' QOS 约束条件</div>');
    h.push('<div class="card"><div class="table-wrap"><table><thead><tr><th>分区</th><th>QOS</th><th>GrpTRES<br><small style="font-weight:400;color:var(--text2)">分区最大总资源</small></th><th>MaxTRES<br><small style="font-weight:400;color:var(--text2)">单任务最大资源</small></th><th>MaxTRESPerUser<br><small style="font-weight:400;color:var(--text2)">用户最大资源</small></th></tr></thead><tbody>');
    cp.forEach(function (c) {
      h.push('<tr><td><strong>' + esc(c.partition) + '</strong></td><td><span class="tag tag-qos">' + esc(c.qos_name) + '</span></td><td>' + esc(c.GrpTRES) + '</td><td>' + esc(c.MaxTRES) + '</td><td>' + esc(c.MaxTRESPerUser) + '</td></tr>');
    });
    h.push('</tbody></table></div>');
    h.push('</div>');
  }
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
    h.push('<div class="card"><div class="table-wrap"><table><thead><tr><th>Job ID</th><th>名称</th><th>状态</th><th>分区</th><th>用户</th><th>CPU</th><th>运行时间</th><th>时限</th><th>原因</th></tr></thead><tbody>');
    jlist.slice(0, 50).forEach(function (j) {
      h.push('<tr><td>' + esc(j.job_id) + '</td><td>' + esc(j.name) + '</td><td>' + tagState(j.status) + '</td><td>' + esc(j.partition) + '</td><td>' + esc(j.user) + '</td><td>' + (j.cpus || 0) + '</td><td>' + esc(j.runtime) + '</td><td>' + esc(j.time_limit) + '</td><td class="cell-ellipsis" title="' + esc(j.reason) + '">' + esc(j.reason) + '</td></tr>');
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
      if (changed) {
        lastRaw = raw;
        lastData = d;
        render(d); // 内容未变化时跳过重渲染，避免整页 DOM 重建
      }
      lastUpdatedStr = (d.overview && d.overview.last_updated) || '--';
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
startClock();

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
