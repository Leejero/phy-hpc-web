// ============================================================
// HPC 集群监控面板 - 主脚本
// 物理与光电工程学院
// ============================================================

// 数据源配置
// 数据来自 GitHub date 仓库
var DATA_URL = 'https://raw.githubusercontent.com/Leejero/date/main/data/slurm.json';
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

function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
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

window.addEventListener('scroll', function () {
  var btn = $('backTop');
  if (window.scrollY > 300) btn.classList.add('show');
  else btn.classList.remove('show');
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

  var h = '';

  // ---------- 概览 ----------
  h += '<div class="section-title" id="overview">📊 集群概览</div>';
  h += '<div class="grid grid-4">';
  h += '<div class="card stat"><div class="num">' + (cs.total_cores || 0) + '</div><div class="label">总核心数</div></div>';
  h += '<div class="card stat green"><div class="num">' + (cs.allocated_cores || 0) + '</div><div class="label">已使用核心</div></div>';
  h += '<div class="card stat cyan"><div class="num">' + (cs.free_cores || 0) + '</div><div class="label">空闲核心</div></div>';
  h += '<div class="card stat ' + (jobs.running > 0 ? 'green' : '') + '"><div class="num">' + (jobs.running || 0) + '</div><div class="label">运行任务</div></div>';
  h += '</div>';
  h += '<div class="grid grid-4" style="margin-top:12px">';
  h += '<div class="card stat"><div class="num">' + (cs.active_nodes || 0) + '/' + (cs.total_nodes || 0) + '</div><div class="label">活跃节点</div></div>';
  h += '<div class="card stat orange"><div class="num">' + (jobs.pending || 0) + '</div><div class="label">等待任务</div></div>';
  h += '<div class="card stat"><div class="num">' + (us.online_terminal || 0) + '</div><div class="label">当前在线人数</div></div>';
  h += '<div class="card stat ' + (cs.cpu_utilization_percent > 80 ? 'orange' : '') + '"><div class="num">' + (cs.cpu_utilization_percent || 0) + '%</div><div class="label">CPU 利用率</div></div>';
  h += '</div>';

  // ---------- 分区 ----------
  h += '<div class="section-title" id="partitions">📦 分区资源</div>';
  h += '<div class="grid grid-' + Math.min(parts.length, 3) + '">';
  parts.forEach(function (p) {
    var ac = p.allowed_cores || 960;
    var uc = p.allocated_cores || 0;
    var fc = p.free_cores || ac;
    var pp = pct(uc, ac);
    var pname = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    h += '<div class="card"><div class="card-title"><span class="dot" style="background:var(--primary)"></span>' + esc(pname) + ' 分区 <span class="tag tag-qos">QOS: ' + esc(p.qos) + '</span></div>';
    h += '<div class="progress-wrap"><div class="progress-label"><span>已使用 ' + uc + ' 核</span><span>' + pp + '%</span></div><div class="progress"><div class="progress-bar ' + barClass(pp) + '" style="width:' + pp + '%"></div></div></div>';
    h += '<div style="display:flex;justify-content:space-between;font-size:.82rem;color:var(--text2);margin-top:6px"><span>允许核心: ' + ac + '</span><span>空闲: ' + fc + '</span></div>';
    h += '<div style="margin-top:8px;font-size:.8rem;color:var(--text2)">节点数: ' + (p.nodes || []).length + '</div></div>';
  });
  h += '</div>';

  // ---------- 告警 ----------
  var alerts = d.alerts || {};
  var alertList = alerts.alerts || [];
  if (alertList.length > 0) {
    h += '<div class="section-title" id="alerts">🚨 告警信息</div><div class="card">';
    alertList.forEach(function (a) {
      h += '<div class="alert-item ' + (a.level === 'critical' ? 'alert-critical' : 'alert-warning') + '"><span class="alert-icon">' + (a.level === 'critical' ? '🔴' : '🟡') + '</span><div><strong>' + esc(a.type) + '</strong> - ' + esc(a.message) + '<br><small style="color:var(--text2)">' + esc(a.timestamp) + '</small></div></div>';
    });
    h += '</div>';
  } else {
    h += '<div class="section-title" id="alerts">🚨 告警信息</div><div class="card" style="text-align:center;color:var(--success);padding:20px">✅ 暂无告警</div>';
  }

  // ---------- 磁盘 ----------
  h += '<div class="section-title" id="disks">💾 磁盘空间</div>';
  h += '<div class="grid grid-' + Math.max(disks.length, 1) + '">';
  disks.forEach(function (dk) {
    var p = dk.usage_percent || 0;
    h += '<div class="card"><div class="card-title"><span class="dot" style="background:' + (dk.is_alert ? 'var(--danger)' : 'var(--success)') + '"></span>' + esc(dk.mount) + '</div>';
    h += '<div class="progress-wrap"><div class="progress-label"><span>' + (dk.used_gb || 0) + 'GB / ' + (dk.total_gb || 0) + 'GB</span><span>' + p + '%</span></div><div class="progress"><div class="progress-bar ' + barClass(p) + '" style="width:' + p + '%"></div></div></div>';
    h += '<div style="font-size:.82rem;color:var(--text2)">可用: ' + (dk.avail_gb || 0) + 'GB</div></div>';
  });
  h += '</div>';

  // ---------- QOS ----------
  var cp = con.partition_constraints || [];
  if (cp.length > 0) {
    h += '<div class="section-title" id="qos">⚙️ QOS 约束条件</div>';
    h += '<div class="card"><div class="table-wrap"><table><tr><th>分区</th><th>QOS</th><th>GrpTRES<br><small style="font-weight:400;color:var(--text2)">分区最大总资源</small></th><th>MaxTRES<br><small style="font-weight:400;color:var(--text2)">单任务最大资源</small></th><th>MaxTRESPerUser<br><small style="font-weight:400;color:var(--text2)">用户最大资源</small></th></tr>';
    cp.forEach(function (c) {
      h += '<tr><td><strong>' + esc(c.partition) + '</strong></td><td><span class="tag tag-qos">' + esc(c.qos_name) + '</span></td><td>' + esc(c.GrpTRES) + '</td><td>' + esc(c.MaxTRES) + '</td><td>' + esc(c.MaxTRESPerUser) + '</td></tr>';
    });
    h += '</table></div>';
    h += '</div>';
  }

  // ---------- 节点 ----------
  h += '<div class="section-title" id="nodes">🖥️ 节点状态</div><div class="card"><div class="node-grid">';
  nodes.forEach(function (n) {
    var s = (n.state || '').toLowerCase();
    var bg = '#e2e8f0';
    if (s === 'idle') bg = '#dbeafe';
    else if (s === 'mixed') bg = '#fef3c7';
    else if (s === 'alloc') bg = '#dcfce7';
    else if (s.includes('down') || s.includes('drain')) bg = '#fee2e2';
    var u = n.users || [];
    h += '<div class="node-chip" style="background:' + bg + '"><div class="n-name">' + esc(n.name) + '</div><div class="n-state">' + tagState(n.state) + '</div><div style="font-size:.72rem;color:var(--text2);margin-top:2px">' + (n.allocated_cores || 0) + '/' + (n.total_cores || 0) + '核 · ' + (n.jobs_running || 0) + '任务</div>' + (u.length ? '<div style="font-size:.7rem;color:var(--text2)">' + u.map(esc).join(', ') + '</div>' : '') + '</div>';
  });
  h += '</div></div>';

  // ---------- 任务列表 ----------
  var runJobs = jlist.filter(function (j) { return j.status === 'RUNNING'; });
  var pendJobs = jlist.filter(function (j) { return j.status === 'PENDING'; });
  if (jlist.length > 0) {
    h += '<div class="section-title" id="jobs">📋 任务列表 <small style="color:var(--text2);font-weight:400">(' + runJobs.length + ' 运行, ' + pendJobs.length + ' 等待)</small></div>';
    h += '<div class="card"><div class="table-wrap"><table><tr><th>Job ID</th><th>名称</th><th>状态</th><th>分区</th><th>用户</th><th>CPU</th><th>运行时间</th><th>时限</th><th>原因</th></tr>';
    jlist.slice(0, 50).forEach(function (j) {
      h += '<tr><td>' + esc(j.job_id) + '</td><td>' + esc(j.name) + '</td><td>' + tagState(j.status) + '</td><td>' + esc(j.partition) + '</td><td>' + esc(j.user) + '</td><td>' + (j.cpus || 0) + '</td><td>' + esc(j.runtime) + '</td><td>' + esc(j.time_limit) + '</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(j.reason) + '">' + esc(j.reason) + '</td></tr>';
    });
    if (jlist.length > 50) h += '<tr><td colspan="9" style="text-align:center;color:var(--text2)">... 仅显示前 50 条，共 ' + jlist.length + ' 条</td></tr>';
    h += '</table></div></div>';
  }

  // ---------- 用户资源 ----------
  if (ulist.length > 0) {
    h += '<div class="section-title" id="users">👥 用户资源</div>';
    h += '<div class="card"><div class="table-wrap"><table><tr><th>用户</th><th>运行</th><th>等待</th><th>核心</th><th>节点</th><th>分区</th><th>在线</th></tr>';
    ulist.forEach(function (u) {
      h += '<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + (u.running_jobs || 0) + '</td><td>' + (u.pending_jobs || 0) + '</td><td>' + (u.total_cores || 0) + '</td><td>' + (u.total_nodes || 0) + '</td><td>' + (u.partitions || []).map(esc).join(', ') + '</td><td>' + (u.is_online ? '<span class="tag tag-online">在线</span>' : '<span style="color:var(--text2)">-</span>') + '</td></tr>';
    });
    h += '</table></div></div>';
  }

  // ---------- 在线终端 ----------
  if (online.length > 0) {
    h += '<div class="section-title" id="online">🌐 在线终端</div>';
    h += '<div class="card"><div class="table-wrap"><table><tr><th>用户</th><th>终端</th><th>来源</th><th>登录时间</th><th>空闲</th><th>会话数</th></tr>';
    online.forEach(function (u) {
      h += '<tr><td><strong>' + esc(u.username) + '</strong></td><td>' + esc(u.tty) + '</td><td>' + esc(u.from) + '</td><td>' + esc(u.login_time) + '</td><td>' + esc(u.idle) + '</td><td>' + (u.sessions || 1) + '</td></tr>';
    });
    h += '</table></div></div>';
  }

  // 底部留白
  h += '<div style="height:60vh"></div>';

  $('app').innerHTML = h;
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
      $('updateTime').textContent = '最后更新: ' + (d.overview && d.overview.last_updated || '--') + ' · 本地时间：' + ts + ' · 每5min刷新一次';
    })
    .catch(function (e) {
      console.warn('数据加载失败:' + e.message);
      if (!lastData) {
        $('loader').innerHTML = '<div style="color:var(--danger)">❌ 数据加载失败<br><small>' + esc(e.message) + '</small></div>';
      }
    });
}

// ============================================================
// 初始化
// ============================================================

fetchData();
refreshTimer = setInterval(fetchData, REFRESH_INTERVAL);

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