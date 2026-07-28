# HPC 集群监控面板

物理与光电工程学院高性能计算集群实时监控系统。采用毛玻璃（Glassmorphism）设计风格，界面简洁通透。

## 功能特性

- 📊 **集群概览** — 总核心数、已用核心、空闲核心、运行任务等实时数据
- 📦 **分区资源** — 各分区核心使用率、QOS 信息
- 🚨 **告警信息** — 集群异常告警实时展示
- 💾 **磁盘空间** — 各挂载点磁盘使用情况
- ⚙️ **QOS 约束** — 分区资源约束条件一览
- 🖥️ **节点状态** — 所有计算节点运行状态
- 📋 **任务列表** — 当前运行与等待中的计算任务
- 👥 **用户资源** — 各用户资源占用情况
- 🌐 **在线终端** — 当前在线用户终端信息
- 📖 **INCAR 手册** — VASP INCAR 参数速查（独立页面，参数数据异步加载）

## 技术栈

- **HTML5** — 语义化页面结构
- **CSS3** — 毛玻璃响应式布局，`backdrop-filter` + 半透明叠层，支持桌面端与移动端
- **JavaScript (Vanilla)** — 数据获取与动态渲染，零依赖

## 数据管道

```
集群端 (Slurm)                         GitHub                      浏览器
┌─────────────────────┐        ┌──────────────────┐        ┌──────────────┐
│ data_collector.py    │        │                  │        │  index.html  │
│  ↓ 生成原始 JSON      │  cron  │  data/slurm.json │  fetch │   ↓ 渲染      │
│ desensitize_slurm.py │ ─────► │  (Contents API)  │ ◄───── │  js/main.js  │
│  ↓ 用户名/IP 脱敏     │        │                  │        │  (5 分钟轮询) │
│ sync.sh 推送          │        └──────────────────┘        └──────────────┘
└─────────────────────┘
```

- **采集**：集群端 `data_collector.py` 调用 `sinfo`/`squeue`/`sacct` 等 Slurm 命令生成 JSON。
- **脱敏**：`scripts/desensitize_slurm.py` 在推送前将真实用户名替换为"姓氏拼音 + 名字首字母"缩写，并对来源 IP 做掩码处理。**严禁向公开仓库推送含真实用户名的数据。**
- **推送**：`sync.sh` 通过 GitHub Contents API 更新 `data/slurm.json`；由 cron 驱动——日间（8:00–23:40）每 20 分钟一次，夜间 2:00/4:00/6:00 各一次。
- **展示**：前端每 5 分钟轮询一次数据文件（条件请求，可命中 304），数据内容未变化时跳过重渲染。

## 项目结构

```
.
├── index.html            # 主监控面板
├── INCAR.html            # VASP INCAR 参数手册（独立页面）
├── css/
│   └── style.css         # 样式文件
├── js/
│   └── main.js           # 主脚本
├── data/
│   ├── slurm.json        # 集群监控数据（已脱敏）
│   └── incar-data.json   # INCAR 参数数据（607 个参数）
├── scripts/
│   └── desensitize_slurm.py  # 用户名/IP 脱敏脚本
├── .github/workflows/
│   └── sync-gitee.yml    # GitHub → Gitee 镜像同步
├── LICENSE               # MIT 协议
└── README.md             # 项目说明
```

## 浏览器兼容性

面向现代浏览器（基线：支持 `fetch`、`backdrop-filter`、CSS Grid 与 ES6）：

| 浏览器 | 最低版本 |
| --- | --- |
| Chrome / Edge | 76+ |
| Firefox | 103+ |
| Safari | 14+ |

不支持 IE。旧版浏览器可正常读取数据但毛玻璃效果会降级。

## 许可

[MIT](LICENSE)

## 开发者

**@Leejero** — 物理与光电工程学院
