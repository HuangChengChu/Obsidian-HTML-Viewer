# Obsidian 单文件 HTML 视图（html-single-file-view）

在 Obsidian 里用**自定义视图**打开单文件 HTML（资讯阅读 / 交互答题），
并把**答题、批注、笔记、手写涂鸦、阅读进度直接写回这个 HTML 文件本身**——
不产生任何附属文件，靠 Obsidian 同步实现手机 / 电脑跨设备接力。

> 配套的单文件 HTML 模板（资讯页 + 答题页）也在 `templates/` 里，成品即用。
>
> **v1.4.0 起，MD 文本的阅读视图也支持了**：手写、标注、笔记、章节进度，
> 数据写进 MD 自己的 frontmatter，同样零附属文件。
> 右下角 `✏️` 触笔按钮**正上方**有一个静止的 `⏸` 开关，点一下临时关停插件，
> 正文立刻恢复成完全可选中、可编辑的状态（默认开着）。

---

## 30 秒上手

### 桌面（本地开发）

```bash
cd ~/Downloads/Obsidian-HTML-Viewer
npm run build:all                                   # 构建插件 + 模板
./scripts/install-to-vault.sh "/你的 vault 路径"   # 安装并启用
# 重启 Obsidian，然后双击 vault 里的 .html 文件
```

### 手机 / 平板（iOS / iPadOS / Android，用 BRAT 装）

iOS 和 Android 上的 Obsidian **不能从社区商店装第三方插件**，BRAT
（Beta Reviewers Auto-update Tester）是官方推荐的变通办法。

1. 在 Obsidian 里装并启用社区插件 **BRAT**（名字是 `Obsidian42 - BRAT`）
2. 命令面板（⌘P / 移动端是搜索栏）→ 执行 `Plugins: Add a beta plugin for testing`
3. 填仓库地址（形如 `owner/repository` 或完整 GitHub URL）
4. 选 `Latest version` → `Add plugin`
5. 到「设置 → 第三方插件」里启用 **HTML 单文件视图**

BRAT 会跟着仓库的 Release 自动更新；也可以在 BRAT 设置里把版本**冻结**在某个 tag。

> 手动安装：下载 Release 里的 `main.js` / `manifest.json` / `styles.css`，
> 放进 vault 的 `.obsidian/plugins/html-single-file-view/` 目录，重启 Obsidian 后启用。
>
> 本插件的 `manifest.json` 里 `isDesktopOnly: false`，代码里**没有任何 Node API 依赖**，
> 可以在 iOS 上正常跑。

---

## 它解决什么

| 老问题 | 本方案 |
|---|---|
| 进度存外部 json / md → 删文件有残留 | 进度写在 HTML 内部 `<script id="html-quiz-progress">` 区块，删文件即彻底干净 |
| localStorage 不能跨设备 | 数据跟着**文件**走，同步软件同步什么就带走什么 |
| 手机答一半、电脑看不到 | 同一个 HTML 文件在两端被同步覆盖即可接力 |
| AI 解读要通读全文 | 数据集中在**一个指定位置**，一次 grep + 一次 JSON.parse 就能取全 |
| 资讯页图片占满屏幕 | 默认缩略，双击放大：等宽 → 全屏 |
| 翻页键挡住文字 / 不好按 | 右侧居中上下三角，40% 透明、拇指间隔、瞬时跳转不闪；触屏点按上半屏向上、下半屏向下 |
| 阅读时想圈画、做题想打草稿 | 页面内置**手写标注层**：笔 / 手指自动分派、3 档粗细 4 色、临时草稿一键清屏、点「保存涂鸦」才落盘 |

---

## 核心特性

**插件侧**
- `registerExtensions(['html'])` 接管 `.html` 打开方式（右键仍可「用默认方式打开」退回）
- iframe sandbox **不给** `allow-same-origin` → 页面处于 opaque origin，碰不到 Obsidian
- postMessage 双向通道：**一次性令牌 + source 双校验**，只处理白名单指令
- 写回：`vault.read` → 文本手术 → `vault.modify`，**只碰当前打开的这一个文件**
- 并发：每文件互斥锁 + 条目级合并 + 墓碑删除 + 常驻「别多设备同时开」提示条
- 6 个命令 / 2 个右键菜单 / ribbon 图标 / `obsidian://html-view?do=…` 无人值守入口

**模板侧**
- 悬浮翻页键：右侧**垂直居中**的上下三角，40% 透明、可拖动、拇指间隔 44px、**瞬时跳转不闪烁**
- 触屏分区翻页：点按上半屏向上、下半屏向下；滑动照常滚动
- 图片双击三态：缩略 → 屏幕等宽 → 全屏（触屏双击手势同样支持）
- 选中文字 → `💬 评注` / `❓ 存疑`（存疑可零文字）
- `📍 标记此处` 位置标记 + `＋ 新笔记`
- 每题可折叠「✎ 我的思路」，答错后补「❓ 为什么选错」
- 章节级阅读进度（滚过章节末尾即算读完）
- **手写标注层**：右下角 `✏️` 进入画笔模式 → SVG 笔迹 / 段落锚点重排校正 /
  笔手指自动分派 / 双击正文 2x 放大 / 清屏 / 橡皮 / 「💾 保存涂鸦」才写盘
- 不在插件环境自动降级到 localStorage / 内存，并明确提示无法跨设备同步

**视图外壳**
- 顶栏取消，状态全部并入底栏：`已保存于 HH:MM:SS` + `· 保留了对方修改 N 处`
- 底栏左侧一个向左的 `‹` 折叠键，点开收纳「重新加载文件 / 复制复习清单 / 使用说明」+ 文件名 + 并发提示
- 保存成功不再在正文里弹黑色提示框（避免打断阅读）

**MD 阅读视图（v1.4.0）**
- 插件对**所有 MD 的阅读视图**生效：手写涂鸦、选中文字加评注/存疑、笔记与标注面板、章节级阅读进度
- 数据写进 **MD 自己的 frontmatter `hvv` 字段**（Obsidian 官方 `processFrontMatter`），
  跟 HTML 一样**零附属文件**，同步软件同步什么就带走什么
- 右下角 `✏️` 触笔按钮；**它正上方**一个静止的 `⏸` 按钮，
  点一下就临时关停插件，正文立刻恢复成完全可选中、可编辑的状态（**默认开着**）
- 只接管阅读视图，**实时预览（编辑态）不碰**——编辑时要能正常改字
- MD 里**不启用**翻页键、触屏分区翻页、图片三态：这三样是网页专属，跟 Obsidian 原生交互打架
- runtime 的界面元素全在专用壳 `.hvv-page-root` 里，**不往 Obsidian 的 body 上加 class**；
  所有文档级监听器都过「事件是否落在当前正文根内」的守卫，不会劫持 Obsidian 自己的界面

---

## 数据契约（一句话版）

进度全在文件末尾这一个块里：

```html
<script id="html-quiz-progress" type="application/json">
{
  "currentQuestion": 3,
  "answers": { "q1": { "value": "B", "at": "…", "why": "…", "wrongReason": "…" } },
  "scrollY": 1200, "scrollPercent": 42, "readDone": false,
  "sectionProgress": { "s1": { "percent": 100, "read": true } },
  "notes": [], "annotations": [], "marks": [],
  "strokes": [ { "id": "s1", "d": "M12,30 l8,4", "color": "ink", "width": 4,
                 "opacity": 1, "anchor": { "text": "被圈住的那段话前 40 字", "dx": 12, "dy": -18 },
                 "at": "…", "saved": true } ],
  "ui": { "pager": { "top": 0.5, "right": 20 }, "inkbar": { "edge": "bottom" } },
  "meta": { "schema": "html-quiz-progress/v1", "updatedAt": "…", "updatedBy": "device-…" }
}
</script>
```

题目与标准答案在另一个静态块 `html-content-meta` 里。
**两者一起 grep，AI 就能自行判分、推导复习清单，不必通读正文。**

详见 [docs/04-HTML模板与数据契约.md](./docs/04-HTML模板与数据契约.md)。

---

## 质量门禁

| 门禁 | 内容 | 状态 |
|---|---|---|
| G1 | 纯函数单测（文本手术 / 转义 / 合并 / 墓碑 / 协议 / 锁 / 复习清单 / frontmatter 契约） | ✅ 70 项 |
| G2 | TypeScript 类型检查 | ✅ 零错 |
| G3 | 构建产物齐全 + manifest 合法 | ✅ |
| G4 | 运行时行为自检（jsdom 跑真实 runtime.js） | ✅ 20 项 |
| G5 | **真实 Obsidian 进程内端到端验收** | ✅ **15/15 通过** |
| G6 | **手写标注层真机验收**（CDP 派发真实 `pointerType:pen` 笔事件） | ✅ **26/26 通过** |
| G7 | **UI 改版真机验收**（翻页键 / 顶底栏合并 / 折叠菜单） | ✅ **25/25 通过**（连跑三遍） |
| G8 | **外部 HTML 真机验收**（无 runtime 的网页也能用上全部功能并写回原文件） | ✅ **30/30 通过** |
| G9 | **MD 阅读视图真机验收**（runtime 注入主页面 / 手写 / 标注 / 笔记 / 进度写回 frontmatter / 关停让位 / 切篇不串台） | ✅ **35/35 通过**（连跑三遍） |

合计单测 **132 项全绿**（含手写层 24 项、翻页专项 12 项、frontmatter 契约 19 项、page 宿主 7 项）。

```bash
npm test                      # G1 + G4
npm --prefix plugin run typecheck   # G2
node scripts/verify-real.mjs  # G5（需要 Obsidian 正在运行）

# G6 / G7 / G8 / G9：需要用调试端口启动 Obsidian
osascript -e 'tell application "Obsidian" to quit' && sleep 4
open -a Obsidian --args --remote-debugging-port=9333 && sleep 10
node scripts/verify-ink-real.mjs   # G6 手写层
node scripts/verify-ui-real.mjs    # G7 UI 改版
node scripts/verify-ext-real.mjs   # G8 外部 HTML
node scripts/verify-md-real.mjs    # G9 MD 阅读视图
```

> **样例页隔离**：G5 / G6 / G7 / G8 一律跑在 `html-view-test/auto-*.html`（每次开跑前用模板覆盖），
> `demo-*.html` 是用户手测数据，自动验收**只读不写**。验收页还带唯一标记
> `<meta name="hvv-test-id">`，工作区里同时开着别的 HTML 视图时也能认准本次这一份。
> 脚本收尾会**自己关掉它打开的 `auto-*` 标签页**，用户的 `demo-*` 一律不动。
>
> **可重复性**：G5 要**连着跑三遍都 15/15** 才算过，G7 同理。单次绿不算数——
> 「第二遍就红」正是揪出「换页残留保存把旧数据写回磁盘」那个 bug 的方式。
>
> **诊断探针**（不是门禁，是用来定位问题的工具）：
> `scripts/probe-touch-coord.mjs`（触摸坐标系到底用哪种）、
> `scripts/probe-write-amplification.mjs`（每个动作触发几次整文件写盘，
> 同步流量核查的实测数据来源，见 [docs/08](./docs/08-同步流量核查与写回策略.md)）。

---

## 打包交付物

```bash
npm run build:all        # 构建模板 + 插件
./scripts/package-dist.sh # 产出两个 zip（版本号取自 package.json）
```

| 产物 | 内容 |
|---|---|
| `dist/html-single-file-view-<版本>.zip` | 插件本体（`main.js` / `manifest.json` / `styles.css`），直接放进 `.obsidian/plugins/html-single-file-view/` |
| `dist/Obsidian-HTML-Viewer-<版本>.zip` | 完整工程（源码 + 模板 + 文档 + 测试 + 验收脚本） |

安装到本机 vault：

```bash
./scripts/install-to-vault.sh "/Users/mac/Documents/Obsidian Vault"
# 然后完全退出并重启 Obsidian（插件在启动时读 community-plugins.json）
```

---

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-架构说明.md](./docs/01-架构说明.md) | 全景图、三层职责、两条数据链、**MD 第二种宿主**、安全模型 |
| [docs/02-实现设计.md](./docs/02-实现设计.md) | 64 条决策总表、数据契约、文本手术算法、合并契约、协议 |
| [docs/03-部署与实机测试步骤.md](./docs/03-部署与实机测试步骤.md) | 安装、启用、验收脚本、实测结果、人工清单 |
| [docs/04-HTML模板与数据契约.md](./docs/04-HTML模板与数据契约.md) | 标记采集规范、AI 取数说明、**生成页面的提示词模板** |
| [docs/05-使用注意与FAQ.md](./docs/05-使用注意与FAQ.md) | 注意事项、28 条 FAQ、已知限制 |
| [docs/06-手写标注层设计.md](./docs/06-手写标注层设计.md) | 手写层设计决策（22 条）、机制说明、实现记录与偏离清单 |
| [docs/07-AI生成HTML适配指引.md](./docs/07-AI生成HTML适配指引.md) | **给 AI / 脚本的生成规范**：三条硬要求 + 提示词模板 + 自检清单 |
| [docs/08-同步流量核查与写回策略.md](./docs/08-同步流量核查与写回策略.md) | **坚果云 WebDAV 流量核查**：机制拆解 + 真机实测的写盘放大倍数 + 四个改进方案 |

---

## 给 AI 生成页面的提示词

见 [docs/04 §5](./docs/04-HTML模板与数据契约.md)，可直接复制使用。
要点：正文放 `<article id="content">`、章节用 `data-sid`、题目用 `data-qid`、
末尾保留两个数据块空壳、内联 runtime 片段。

---

## 许可

MIT
