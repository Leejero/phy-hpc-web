// ============================================================
// HPC 集群监控面板 - 主脚本
// 物理与光电工程学院
// ============================================================

// 数据源配置
// 数据来自 GitHub date 仓库
var DATA_URL = 'data/slurm.json';
var REFRESH_INTERVAL = 300000;
var refreshTimer = null;
var lastData = null;

// ============================================================
// 工具函数
// ============================================================

function getDataUrl() {
  return DATA_URL + '?t=' + Date.now();
}

function $(id) {
  return document.getElementById(id);
}

var _escEl = null;
function esc(s) {
  if (!s) return '';
  if (!_escEl) _escEl = document.createElement('div');
  _escEl.textContent = s;
  return _escEl.innerHTML;
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
    if (window.scrollY > 300) btn.classList.add('show');
    else btn.classList.remove('show');
    _backTopTimer = null;
  });
}, { passive: true });

// ============================================================
// 侧边栏滚动高亮 + 平滑滚动（仅初始化一次）
// ============================================================

var _sidebarInited = false;

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
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].el.getBoundingClientRect().top <= 80) cur = sections[i];
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
      if (el) window.scrollTo({ top: el.offsetTop - 10, behavior: 'smooth' });
    });
  });
}

// ============================================================
// 渲染面板数据
// ============================================================

function render(d) {
  $('loader').style.display = 'none';

  var ov = d.overview || {};
  var cs = ov.current_status || {};
  var ci = d.cluster_info || {};
  var jobs = ov.jobs || {};
  var us = ov.users || {};
  var disks = d.disks || [];
  var parts = d.partitions || [];
  var nodes = d.nodes || [];
  var jlist = d.jobs || [];
  var ulist = d.users || [];
  var online = d.online_users || [];
  var con = d.constraints || {};

  var clusterName = ci.name || 'HPC 集群监控面板';
  clusterName = clusterName.replace(/物电学院/g, '物理与光电工程学院');
  $('clusterName').textContent = clusterName;
  $('clusterSub').textContent = 'Slurm ' + (ov.slurm_version || 'N/A') + ' · 运行时间 ' + (ov.server_uptime || 'N/A');
  $('updateTime').textContent = '最后更新: ' + (ov.last_updated || '--');

  var h = [];

  // ---------- 概览 ----------
  h.push('<div class="section-title" id="overview">📊 集群概览</div>');
  h.push('<div class="grid grid-4">');
  h.push('<div class="card stat"><div class="num">' + (cs.total_cores || 0) + '</div><div class="label">总核心数</div></div>');
  h.push('<div class="card stat green"><div class="num">' + (cs.allocated_cores || 0) + '</div><div class="label">已使用核心</div></div>');
  h.push('<div class="card stat cyan"><div class="num">' + (cs.free_cores || 0) + '</div><div class="label">空闲核心</div></div>');
  h.push('<div class="card stat ' + (jobs.running > 0 ? 'green' : '') + '"><div class="num">' + (jobs.running || 0) + '</div><div class="label">运行任务</div></div>');
  h.push('</div>');
  h.push('<div class="grid grid-4" style="margin-top:12px">');
  h.push('<div class="card stat"><div class="num">' + (cs.active_nodes || 0) + '/' + (cs.total_nodes || 0) + '</div><div class="label">活跃节点</div></div>');
  h.push('<div class="card stat orange"><div class="num">' + (jobs.pending || 0) + '</div><div class="label">等待任务</div></div>');
  h.push('<div class="card stat"><div class="num">' + (us.online_terminal || 0) + '</div><div class="label">当前在线人数</div></div>');
  h.push('<div class="card stat ' + (cs.cpu_utilization_percent > 80 ? 'orange' : '') + '"><div class="num">' + (cs.cpu_utilization_percent || 0) + '%</div><div class="label">CPU 利用率</div></div>');
  h.push('</div>');

  // ---------- 分区 ----------
  h.push('<div class="section-title" id="partitions">📦 分区资源</div>');
  h.push('<div class="grid grid-' + Math.min(parts.length, 3) + '">');
  parts.forEach(function (p) {
    var ac = p.allowed_cores || 960;
    var uc = p.allocated_cores || 0;
    var fc = p.free_cores || ac;
    var pp = pct(uc, ac);
    var pname = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    h.push('<div class="card"><div class="card-title"><span class="dot" style="background:var(--primary)"></span>' + esc(pname) + ' 分区 <span class="tag tag-qos">QOS: ' + esc(p.qos) + '</span></div>');
    h.push('<div class="progress-wrap"><div class="progress-label"><span>已使用 ' + uc + ' 核</span><span>' + pp + '%</span></div><div class="progress"><div class="progress-bar ' + barClass(pp) + '" style="width:' + pp + '%"></div></div></div>');
    h.push('<div style="display:flex;justify-content:space-between;font-size:.82rem;color:var(--text2);margin-top:6px"><span>允许核心: ' + ac + '</span><span>空闲: ' + fc + '</span></div>');
    h.push('<div style="margin-top:8px;font-size:.8rem;color:var(--text2)">节点数: ' + (p.nodes || []).length + '</div></div>');
  });
  h.push('</div>');

  // ---------- 告警 ----------
  var alerts = d.alerts || {};
  var alertList = alerts.alerts || [];
  if (alertList.length > 0) {
    h.push('<div class="section-title" id="alerts">🚨 告警信息</div><div class="card">');
    alertList.forEach(function (a) {
      h.push('<div class="alert-item ' + (a.level === 'critical' ? 'alert-critical' : 'alert-warning') + '"><span class="alert-icon">' + (a.level === 'critical' ? '🔴' : '🟡') + '</span><div><strong>' + esc(a.type) + '</strong> - ' + esc(a.message) + '<br><small style="color:var(--text2)">' + esc(a.timestamp) + '</small></div></div>');
    });
    h.push('</div>');
  } else {
    h.push('<div class="section-title" id="alerts">🚨 告警信息</div><div class="card" style="text-align:center;color:var(--success);padding:20px">✅ 暂无告警</div>');
  }

  // ---------- 磁盘 ----------
  h.push('<div class="section-title" id="disks">💾 磁盘空间</div>');
  h.push('<div class="grid grid-' + Math.max(disks.length, 1) + '">');
  disks.forEach(function (dk) {
    var p = dk.usage_percent || 0;
    h.push('<div class="card"><div class="card-title"><span class="dot" style="background:' + (dk.is_alert ? 'var(--danger)' : 'var(--success)') + '"></span>' + esc(dk.mount) + '</div>');
    h.push('<div class="progress-wrap"><div class="progress-label"><span>' + (dk.used_gb || 0) + 'GB / ' + (dk.total_gb || 0) + 'GB</span><span>' + p + '%</span></div><div class="progress"><div class="progress-bar ' + barClass(p) + '" style="width:' + p + '%"></div></div></div>');
    h.push('<div style="font-size:.82rem;color:var(--text2)">可用: ' + (dk.avail_gb || 0) + 'GB</div></div>');
  });
  h.push('</div>');

  // ---------- QOS ----------
  var cp = con.partition_constraints || [];
  if (cp.length > 0) {
    h.push('<div class="section-title" id="qos">⚙️ QOS 约束条件</div>');
    h.push('<div class="card"><div class="table-wrap"><table><tr><th>分区</th><th>QOS</th><th>GrpTRES<br><small style="font-weight:400;color:var(--text2)">分区最大总资源</small></th><th>MaxTRES<br><small style="font-weight:400;color:var(--text2)">单任务最大资源</small></th><th>MaxTRESPerUser<br><small style="font-weight:400;color:var(--text2)">用户最大资源</small></th></tr>');
    cp.forEach(function (c) {
      h.push('<tr><td><strong>' + esc(c.partition) + '</strong></td><td><span class="tag tag-qos">' + esc(c.qos_name) + '</span></td><td>' + esc(c.GrpTRES) + '</td><td>' + esc(c.MaxTRES) + '</td><td>' + esc(c.MaxTRESPerUser) + '</td></tr>');
    });
    h.push('</table></div>');
    h.push('</div>');
  }

  // ---------- 节点 ----------
  h.push('<div class="section-title" id="nodes">🖥️ 节点状态</div><div class="card"><div class="node-grid">');
  nodes.forEach(function (n) {
    var s = (n.state || '').toLowerCase();
    var bg = 'rgba(79,110,247,.05)';
    if (s === 'idle') bg = 'rgba(6,182,212,.08)';
    else if (s === 'mixed') bg = 'rgba(245,158,11,.08)';
    else if (s === 'alloc') bg = 'rgba(34,197,94,.08)';
    else if (s.includes('down') || s.includes('drain')) bg = 'rgba(239,68,68,.08)';
    var u = n.users || [];
    h.push('<div class="node-chip" style="background:' + bg + '"><div class="n-name">' + esc(n.name) + '</div><div class="n-state">' + tagState(n.state) + '</div><div style="font-size:.72rem;color:var(--text2);margin-top:2px">' + (n.allocated_cores || 0) + '/' + (n.total_cores || 0) + '核 · ' + (n.jobs_running || 0) + '任务</div>' + (u.length ? '<div style="font-size:.7rem;color:var(--text2)">' + u.map(esc).join(', ') + '</div>' : '') + '</div>');
  });
  h.push('</div></div>');

  // ---------- 任务列表 ----------
  var runJobs = jlist.filter(function (j) { return j.status === 'RUNNING'; });
  var pendJobs = jlist.filter(function (j) { return j.status === 'PENDING'; });
  if (jlist.length > 0) {
    h.push('<div class="section-title" id="jobs">📋 任务列表 <small style="color:var(--text2);font-weight:400">(' + runJobs.length + ' 运行, ' + pendJobs.length + ' 等待)</small></div>');
    h.push('<div class="card"><div class="table-wrap"><table><tr><th>Job ID</th><th>名称</th><th>状态</th><th>分区</th><th>用户</th><th>CPU</th><th>运行时间</th><th>时限</th><th>原因</th></tr>');
    jlist.slice(0, 50).forEach(function (j) {
      h.push('<tr><td>' + esc(j.job_id) + '</td><td>' + esc(j.name) + '</td><td>' + tagState(j.status) + '</td><td>' + esc(j.partition) + '</td><td>' + esc(j.user) + '</td><td>' + (j.cpus || 0) + '</td><td>' + esc(j.runtime) + '</td><td>' + esc(j.time_limit) + '</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(j.reason) + '">' + esc(j.reason) + '</td></tr>');
    });
    if (jlist.length > 50) h.push('<tr><td colspan="9" style="text-align:center;color:var(--text2)">... 仅显示前 50 条，共 ' + jlist.length + ' 条</td></tr>');
    h.push('</table></div></div>');
  }

  // ---------- 用户资源 ----------
  if (ulist.length > 0) {
    h.push('<div class="section-title" id="users">👥 用户资源</div>');
    h.push('<div class="card"><div class="table-wrap"><table><tr><th>用户</th><th>运行</th><th>等待</th><th>核心</th><th>节点</th><th>分区</th><th>在线</th></tr>');
    ulist.forEach(function (u) {
      h.push('<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + (u.running_jobs || 0) + '</td><td>' + (u.pending_jobs || 0) + '</td><td>' + (u.total_cores || 0) + '</td><td>' + (u.total_nodes || 0) + '</td><td>' + (u.partitions || []).map(esc).join(', ') + '</td><td>' + (u.is_online ? '<span class="tag tag-online">在线</span>' : '<span style="color:var(--text2)">-</span>') + '</td></tr>');
    });
    h.push('</table></div></div>');
  }

  // ---------- 在线终端 ----------
  if (online.length > 0) {
    h.push('<div class="section-title" id="online">🌐 在线终端</div>');
    h.push('<div class="card"><div class="table-wrap"><table><tr><th>用户</th><th>终端</th><th>来源</th><th>登录时间</th><th>空闲</th><th>会话数</th></tr>');
    online.forEach(function (u) {
      h.push('<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + esc(u.tty) + '</td><td>' + esc(u.from) + '</td><td>' + esc(u.login_time) + '</td><td>' + esc(u.idle) + '</td><td>' + (u.sessions || 1) + '</td></tr>');
    });
    h.push('</table></div></div>');
  }

  $('app').innerHTML = h.join('');
  initSidebarScroll();
  initSidebarNavClose();
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

  fetch(getDataUrl(), ctrl ? { signal: ctrl.signal } : {})
    .then(function (r) {
      if (tid) clearTimeout(tid);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (d) {
      lastData = d;
      render(d);
      var now = new Date();
      var ts = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      $('updateTime').textContent = '最后更新: ' + (d.overview && d.overview.last_updated || '--') + ' · 本地时间：' + ts;
    })
    .catch(function (e) {
      console.warn('数据加载失败:' + e.message);
      if (!lastData) {
        $('loader').innerHTML = '<div style="color:var(--danger)">❌ 数据加载失败<br><small>' + esc(e.message) + '</small></div>';
      }
    });
}

// ============================================================
// 浮动通知弹窗关闭
// ============================================================

function closeFloatNotice() {
  var el = document.getElementById('floatNotice');
  if (el) el.classList.add('hidden');
  sessionStorage.setItem('hpc_notice_closed', '1');
}

function restoreFloatNotice() {
  if (sessionStorage.getItem('hpc_notice_closed') === '1') {
    var el = document.getElementById('floatNotice');
    if (el) el.classList.add('hidden');
  }
}

// ============================================================
// 用户搜索
// ============================================================

var _searchTimer = null;

function positionSearchResults() {
  var input = $('userSearchInput');
  var results = $('userSearchResults');
  if (!input || !results) return;
  var rect = input.getBoundingClientRect();
  results.style.top = (rect.bottom + 6) + 'px';
  results.style.left = rect.left + 'px';
  results.style.width = rect.width + 'px';
}

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
      h.push('<div class="search-result-section"><h4>📋 任务 (' + userJobs.length + ')</h4>');
      h.push('<div class="table-wrap"><table><tr><th>ID</th><th>名称</th><th>状态</th><th>CPU</th><th>运行时间</th></tr>');
      userJobs.slice(0, 10).forEach(function (j) {
        h.push('<tr><td>' + esc(j.job_id) + '</td><td>' + esc(j.name) + '</td><td>' + tagState(j.status) + '</td><td>' + (j.cpus || 0) + '</td><td>' + esc(j.runtime) + '</td></tr>');
      });
      if (userJobs.length > 10) h.push('<tr><td colspan="5" style="text-align:center;color:var(--text2);font-size:.75rem">... 共 ' + userJobs.length + ' 条</td></tr>');
      h.push('</table></div></div>');
    }

    // User's online sessions
    var userOnline = online.filter(function (o) { return o.username === uname; });
    if (userOnline.length > 0) {
      h.push('<div class="search-result-section"><h4>🌐 在线终端</h4>');
      h.push('<div class="table-wrap"><table><tr><th>终端</th><th>来源</th><th>登录时间</th><th>空闲</th></tr>');
      userOnline.forEach(function (o) {
        h.push('<tr><td>' + esc(o.tty) + '</td><td>' + esc(o.from) + '</td><td>' + esc(o.login_time) + '</td><td>' + esc(o.idle) + '</td></tr>');
      });
      h.push('</table></div></div>');
    }
  });

  if (matched.length > 5) {
    h.push('<div class="search-no-result" style="font-size:.78rem">还有 ' + (matched.length - 5) + ' 个匹配用户，请输入更精确的用户名</div>');
  }

  results.innerHTML = h.join('');
  results.classList.add('show');
  positionSearchResults();
}

function initUserSearch() {
  var input = $('userSearchInput');
  var results = $('userSearchResults');
  if (!input) return;

  input.addEventListener('input', function () {
    if (_searchTimer) clearTimeout(_searchTimer);
    var val = input.value;
    _searchTimer = setTimeout(function () {
      searchUser(val);
    }, 150);
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.user-search-wrap') && !e.target.closest('.user-search-results')) {
      $('userSearchResults').classList.remove('show');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      $('userSearchResults').classList.remove('show');
      $('userSearchInput').blur();
    }
  });

  window.addEventListener('resize', function () {
    if ($('userSearchResults').classList.contains('show')) {
      positionSearchResults();
    }
  });
}

// ============================================================
// 初始化
// ============================================================

fetchData();
refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);
restoreFloatNotice();
initUserSearch();

document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  } else {
    fetchData();
    refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);
  }
});
