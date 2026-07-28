# 更新日志 (Changelog)

> 本仓库为静态前端（GitHub Pages 部署），版本号仅作发布标记，不含编译产物。
> 数据由集群端定时生成并推送（`data/slurm.json`），页面每 5 分钟轮询检查更新。
> 历史版本 V1.0 / v2.0 / V3.0 / V4.0 / V5 已发布于 GitHub Releases；本文件自 **V5.1** 起采用"发布说明 + 全量补录"结构。

---

## V5.1 · 2026-07-28（补充版本：平台公告居中 + 全量改动补录）

**本次发布仅含两处增量，相对 V5 代码改动极小：**

### 1. 平台公告板块「上下左右整体居中」
- 卡片改为 `display:flex; flex-direction:column`，`align-items:center`（左右居中）+ `justify-content:center`（上下居中）+ `text-align:center`。
- 设定 `min-height: 50vh` 作为首屏纵向居中基准；移动端（≤640px）降为 `38vh`，避免小屏留白过高。
- 公告标题去掉原有左侧强调条（`border-left` / `padding-left`），并为 `.announcement-card .section-title` 设置 `justify-content:center`，与整体居中一致。
- 子模块同步居中：`.ann-sub` 限宽 `max-width:720px` 居中；`.ann-sub-title`（圆点+标题）、`.ann-strategy`（三枚信息 pill）、`.ann-features`（九宫格）均改为 `justify-content:center`；pill 内部文字左对齐以保证两行可读，pill 本身在行内居中。

### 2. 全量改动补录（详见下方「本窗口全量改动补录」）
- 原 V5 说明仅覆盖"平台公告 + 前期界面优化"，遗漏了本窗口早期的脱敏、代码审查、健壮性修复等大量改动。
- 本版本将自 **slurm.json 信息脱敏** 起的全部改动与已知 bug 完整归档，便于追溯。

---

## 本窗口全量改动补录（自 slurm.json 信息脱敏起，覆盖 V4 → V5）

> 以下按时间顺序归档本对话窗口内的全部改动，含问题定位与 bug 清单。

### 1. slurm.json 信息脱敏（P0 隐私）

**问题**
- 公开仓库的 `data/slurm.json` 直接暴露 **12 个集群真实用户名**（拼音全拼，如 `songhongyue`），属隐私泄露 P0 风险。
- 该文件由集群端定时脚本自动推送，若仅前端脱敏，下次自动推送会立即回灌真实用户名。

**脱敏规则（与用户确认）**
- 拼音全拼姓名 → 姓全拼 + 名首字母：`songhongyue → songhy`。
- 已缩写的（如 `zhangyn` / `zhangxx`）保持不变。
- IP 地址做掩码处理；删除若干前端用不到的字段。

**实现**
- 编写 `scripts/desensitize_slurm.py`（纯标准库，无第三方依赖）：
  - 拼音音节切分判定全拼 + 常见姓氏白名单（约 130 个）；
  - 冲突时追加数字后缀；
  - 映射关系缓存到 `slurm_name_map.json`（存于仓库外，避免再次泄露）。
- 映射结果：7 个需缩写（如 `huoxy / lim / liudd / songhy / wangjj / yinl / zhaob`），5 个保持原样。
- 文件体积 `34.3 KB → 16.0 KB`。

**历史清理**
- 使用 `git filter-repo` 从全部提交历史中移除 `data/slurm.json` 等 4 个文件：**4691 提交 → 40 提交**，零残留。
- 干净仓库落地于 `phy-hpc-web-full/`。
- ⚠️ 注意：集群端数据管线未脱敏前，下次自动推送会覆盖回真实用户名——部署时必须先在集群端启用脱敏脚本（关键步骤）。

### 2. 前端代码审查 25 项问题（→ V4 基线）

通读全部 7 个源文件，按 6 个维度共提出 **25 项问题**，产出《phy-hpc-web-代码审查报告.md》。重点 bug / 风险：

- **隐私/安全**
  - `slurm.json` 公开暴露 12 个真实用户名（P0，已随脱敏解决）。
  - `main.js` 的 `esc()` 不转义双引号，`title` 属性存在 HTML 注入面（P0）。
  - 前端硬编码集群名（应数据驱动，避免多集群部署串名）。
  - 仓库多处残留旧名 `date`（Gitee 镜像仓库名仍为 `date.git`）。
- **性能**
  - `INCAR.html` 内联约 1MB JSON，首屏阻塞（P1）。
  - 引用 Google Fonts，大陆网络不可达导致字体回退/卡顿（P1）。
- **样式/布局**
  - `grid-1` CSS 类缺失，当前数据已触发样式错乱。
  - 右下角浮动通知采用全视口 120s 漂移动画，体验干扰。
  - 多张表格缺 `thead/tbody` 语义结构。
- **健壮性**
  - `fetch` 错误路径未 `clearTimeout`，错误态定时器泄漏。
  - `p.name` 判空缺失，节点名缺失时可能报错。
  - 用户搜索下拉在长列表下定位错位。
- **可访问性**
  - `progressbar` 缺少无障碍属性。
  - 缺 `meta description` 与 `aside/main/footer` 语义标签。
- **工程化**
  - 缺 `LICENSE` / `.gitignore` / `README`。
  - `CSP` 未加固，`favicon` 缺失。

### 3. 前端布局与健壮性修复（9 项，本地提交 `9e298bb`）

针对审查中的若干缺陷做本地修复（未推送，随后续版本并入）：

1. `esc()` 补全双引号转义 + 0 值语义化显示——修复 P0 注入面与空值显示异常。
2. 补 `grid-1` 类 + `grid-N` 截断（`.cell-ellipsis`）——修复类缺失触发的样式错乱。
3. `p.name` 判空——防止节点名缺失时报错中断渲染。
4. 搜索下拉 `scroll` 重定位——修复长列表下拉错位。
5. `fetch` 错误路径 `clearTimeout`——修复错误态定时器泄漏。
6. 底部 40vh 留白改为"滚动到底高亮末节"——消除大块空白。
7. 浮动通知动画 `top/left` 改 `transform(vw/vh)`——修复动画卡顿与定位问题。
8. `index.html` 语义化（`aside/main/footer`）+ `meta description` + SVG `favicon` + `noopener` + 内联 `hover` 改 CSS 类（`.sidebar-divider` / `.sidebar-extra`）——修复语义/SEO/安全。
9. 表格补 `thead/tbody`（6 处）——修复表格语义与可访问性。

### 4. V4 基线发布内容

- 前端代码审查 25 项问题修复：隐私脱敏（运行时不留真实用户名）、`esc()` 引号转义、移除前端硬编码集群名、仓库旧名 `date` 清理。
- `INCAR.html` 参数外置为 `data/incar-data.json` 异步加载（页面体积 1MB → 23KB），`CSP` / `meta` / `favicon` 加固。
- `main.js` 渲染拆分为 10 个函数、数据未变跳过重渲染、`progressbar` 无障碍化。
- 新增 `LICENSE`(MIT) / `.gitignore` / `README`（数据管道说明 + 浏览器基线）。

### 5. 新增「平台公告」栏目

- 栏目名定为四字 **平台公告**（侧栏首项 + 新 SVG 图标 `ic-bullhorn` 喇叭）。
- 内容两栏卡片（桌面 `grid` 2 列 / 移动 1 列堆叠）：
  - 左「数据刷新策略」= 由原右下角浮动通知（`#floatNotice`）整体迁移——日间 08:00–24:00 每 20 分钟刷新、夜间 00:00–08:00 每 2 小时刷新、页面每 5 分钟核查最新数据。
  - 右「功能简介」= 页面用途说明 + 9 个模块一句话介绍。
- 清理原右下角浮动通知的 DOM / 样式 / 逻辑（`closeFloatNotice`、`restoreFloatNotice`、`sessionStorage` 相关）一并下线。

### 6. 平台公告二次改版（平衡与美观）

- **问题**：首版左右两栏高度悬殊（左 3 行 vs 右 9 行列表），视觉失衡且被评价"丑陋"。
- **修复**：改为纵向堆叠，消除左右落差：
  - 上块「数据刷新策略」= 横向三枚信息 pill（☀️ 日间 20 分 / 🌙 夜间 2h / 🔄 页面 5 分核查）。
  - 下块「功能简介」= 一句说明 + 3×3 特性卡片网格（`ann-feat`）。
  - 两块以 `.ann-sub + .ann-sub` 自动加分隔线。
- 删除首版旧类（`ann-block/ann-row/ann-tag/ann-text/ann-note/ann-list/announcement-grid`），新增 `ann-sub/ann-sub-title/ann-strategy/ann-pill/ann-pill-ico/ann-pill-txt/ann-intro/ann-features/ann-feat`；移动端九宫格降为 2 列。

### 7. V5 发布

- **推送**：`main` 推送至 `da0f84e`；并入集群端数据提交后 merge（**非 rebase**，避免历史损坏）；创建并推送带注释标签 `V5`。
- **GitHub Release V5**：名称"V5 · 平台公告栏目 + 界面优化收尾"，说明写入本文件 V5 段落；发布时间 2026-07-28。
- **轮询说明**：页面轮询维持 **5 分钟**（`REFRESH_INTERVAL = 300000`）。该频率独立于数据约 20 分钟的生成节奏，用于把"看到最新数据的延迟"压到 ≤5 分钟；数据未变时走条件请求（304）+ 跳过重渲染，开销可忽略。
- **本轮并入的界面优化（已随前期提交上线，V5 一并归档）**：
  - SVG 图标体系：内联 `<symbol>` 精灵（13 图标）替换侧栏/导航 emoji，跨平台一致、可随 `currentColor` 着色。
  - 空态占位卡：分区 / 磁盘 / 节点 / 任务 / 在线 / 用户数据为空时显示占位卡，不再整节消失。
  - 刷新失败提示：`fetch` 失败时 `#updateTime` 显示"⚠ 刷新失败 · 上次成功"并加 `badge-warn`。
  - 设计系统：引入半径 / 间距 token、`--bg-gradient` / `--shadow-lg` / `--footer-h`；JS 内联样式外提为语义类（`.kv-row` / `.sub-text` / `.cell-ellipsis` / `.mt-md`）。
  - 无障碍：新增 `prefers-reduced-motion` 守卫。

---

## 待办（用户侧，非本仓库）

- 集群端 `data_collector.py` 的 `CLUSTER_NAME` 仍会回退为"物电学院"，需上传修正后的脱敏版本。
- 在线终端数据缺口：建议诊断 `who -u` 采集逻辑。
