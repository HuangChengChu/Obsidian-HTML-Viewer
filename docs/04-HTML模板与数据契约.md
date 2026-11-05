# HTML 模板与数据契约

> 给两拨人看：**① 你（使用者）** 怎么读这份契约；**② AI Agent** 怎么从 HTML 里精准取数。
> 配套实现细节见 [02-实现设计.md](./02-实现设计.md)。

---

## 1. 成品 HTML 的结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>页面标题</title>

<!-- ================= AI 快速提取说明（人类可读的注释） =================
     用户交互数据统一位于本文件末尾的 script 区块（id = html-quiz-progress，
     type = application/json）。
     提取正则：/<script id="html-quiz-progress" type="application\/json">([\s\S]*?)<\/script>/
     解析后重点字段：
       answers[qid].value    用户作答（单选取字符串，多选取数组）
       answers[qid].why      用户当时的思路
       answers[qid].wrongReason  选错原因（自由文本）
       notes[]               我的文字 / 灵感
       annotations[]         对选中文字的评注（quote 锚点）
       marks[]               位置标记（y 锚点）
       strokes[]             手写涂鸦（SVG 路径；anchor.text 说明画在哪一段）
       sectionProgress[sid]  章节阅读进度
     正文在 <article id="content"> 内，与数据区物理分离。
     题目与标准答案在 <script id="html-content-meta"> 内（静态，插件不写）。
     ================================================================= -->

<style>…</style>
</head>
<body>

<article id="content">
  <!-- 正文。章节用 <section data-sid="s1" data-stitle="章节名"> 标记；
       没有显式标记时运行时按 h2/h3 自动切分 -->
</article>

<section id="html-interaction-zone">
  <!-- 我的笔记 / 评注 / 标记：由数据区运行时渲染，不落第二份数据 -->
</section>

<script id="html-content-meta" type="application/json">
{ "title": "…", "kind": "article", "sections": [], "questions": [] }
</script>

<script id="html-quiz-progress" type="application/json">
{ "currentQuestion": 1, "answers": {}, "scrollY": 0, "notes": [], "annotations": [], "marks": [], "strokes": [], "meta": { "schema": "html-quiz-progress/v1" } }
</script>

<script>/* 运行时（翻页 / 图片双击 / 标记 / 评注 / 思路 / 章节 / 降级 / 防抖保存） */</script>
</body>
</html>
```

---

## 2. 数据契约（进度块）

```jsonc
{
  "meta": { "schema": "html-quiz-progress/v1", "updatedAt": "…", "updatedBy": "device-xxxx" },
  "currentQuestion": 3,
  "answers": {
    "q1": { "value": "B", "at": "…", "why": "我的思路", "wrongReason": "自由文本" },
    "q2": ["A", "C"],
    "q3": "D"
  },
  "scrollY": 1200, "scrollPercent": 42, "readDone": false,
  "sectionProgress": { "s1": { "title": "第一章", "percent": 100, "read": true, "at": "…" } },
  "notes":       [ { "id": "n1", "text": "…", "at": "…", "tags": [], "category": "" } ],
  "annotations": [ { "id": "a1", "text": "…", "quote": "选中原文", "occurrence": 1, "doubt": false, "at": "…" } ],
  "marks":       [ { "id": "m1", "text": "…", "y": 1280, "quote": "最近段落首80字", "doubt": false, "at": "…" } ],
  "strokes":     [ { "id": "s1", "d": "M12,30 l8,4 l-3,9", "color": "ink", "width": 4,
                    "opacity": 1, "anchor": { "text": "被圈住的那段话前 40 字", "dx": 12, "dy": -18 },
                    "at": "…", "saved": true } ],
  "ui": { "pager": { "top": 0.5, "right": 20 }, "inkbar": { "edge": "bottom" } }
}
```

**约定**
- 只存**原始用户输入**，不存任何派生结论（对错、复习清单、分类都不落盘）
- `tags` / `category` 是预留空位，供后期 AI 回写分类建议
- `deleted: true` 是删除墓碑，各端读取时隐藏，插件命令可清理
- 裸值写法 `{ "q3": "D" }` 与对象写法等价，读取端自动归一

**`ui`（界面偏好）**

| 字段 | 含义 |
|---|---|
| `ui.pager.top` | 翻页键的垂直位置，**0~1 的比例**（0.5 = 垂直居中） |
| `ui.pager.right` | 翻页键距右边缘的像素 |
| `ui.inkbar.edge` | 手写工具条吸附边：`top` / `bottom` / `left` / `right` |

> 旧版 `ui.pager = { x, y }`（x 距右、y 距下）会被自动迁移成 `{ top: 0.5, right: x }`。

**`strokes[]`（手写涂鸦）字段说明**

| 字段 | 含义 |
|---|---|
| `id` | 笔迹唯一 id（合并契约按它去重，删除走墓碑） |
| `d` | SVG 路径：首点绝对坐标，其后全相对（`M x,y l dx,dy …`），矢量、体积小 |
| `color` | **语义键**：`ink` / `red` / `yellow` / `blue`（不存十六进制；`ink` 在暗色主题自动反白） |
| `width` | 粗细档位：`2` / `4` / `8` |
| `opacity` | `yellow` 固定 `0.45`，其余 `1` |
| `anchor.text` | 这一笔贴在哪个块级元素上（该块文本前 40 字） |
| `anchor.dx/dy` | 笔迹起点相对该块左上角的偏移（重排校正用） |
| `at` / `saved` | 时间戳 / 是否已保存（临时草稿**永远不会**进这个数组） |

> ⚠️ 重排校正产生的偏移量只存在内存里，**不写回文件**——避免两台设备为坐标互相覆盖。
> 笔画形状本身无语义价值（不做图形识别）；对 AI 有意义的是 `anchor.text`（画在哪一段）
> 与 `width`/`color`（圈画重点的力度感）。

---

## 3. 标记采集规范（怎么标、怎么收）

### 3.1 三个入口

| 入口 | 操作 | 落到哪 | 锚点 |
|---|---|---|---|
| 选中文字 | 选中正文 → 浮出 `💬 评注` / `❓ 存疑` | `annotations[]` | `quote` + `occurrence` |
| 位置标记 | 底部常驻 `📍 标记此处` | `marks[]` | `y` + 最近段落首 80 字 |
| 随手笔记 | 底部 `＋ 新笔记` | `notes[]` | 无 |

### 3.2 答题页额外两个入口

| 入口 | 操作 | 落到哪 |
|---|---|---|
| 我的思路 | 每题下方可折叠输入框 `✎ 我的思路` | `answers[q].why` |
| 选错原因 | 判错后出现 `❓ 为什么选错？`（自由文本） | `answers[q].wrongReason` |

### 3.3 规则细节

- **存疑可以零文字**：点「❓」弹出小框，直接回车即记一条 `doubt:true`、`text:""` 的条目
- **回找**：点底部列表任一条 → 滚回锚点位置 + 闪烁高亮 1.5 秒；锚点因正文改动失效时，提示「原文已改动，锚点失效」并给出最接近的位置
- **章节已读**：该章节最后一个元素进入视口 → `read:true`；同时记录该章 `percent`
- **整篇已读**：滚动 ≥95% → `readDone:true`，手动按钮可撤销
- **正文痕迹**：被评注/存疑的选中文本淡黄底；被位置标记的段落左侧竖线 + 序号

---

## 4. AI Agent 取数说明

### 4.1 两条 grep 拿全部上下文

```bash
# ① 用户产出（进度块）
grep -oP '(?s)(?<=<script id="html-quiz-progress" type="application/json">).*?(?=</script>)' page.html

# ② 题目与标准答案（内容元数据块，静态）
grep -oP '(?s)(?<=<script id="html-content-meta" type="application/json">).*?(?=</script>)' page.html
```

> ⚠️ **提取正则必须带上 `type="application/json"`**，否则页面顶部注释里提到的同名标签会先被命中。
> 插件侧的匹配更严格：它会**先剔除所有 HTML 注释**再匹配，所以即使注释里写了
> `<script id="html-quiz-progress">` 也不会误伤（有专门的回归测试盯着）。

> 只读① = 拿到用户的全部作答、思路、评注、标记、笔记、阅读进度
> ①+② = 拿到题目与标准答案 → 可自行判分、推导复习清单
> **不需要读正文全文**——这正是这套契约的目的

### 4.2 字段速查

| 想问的问题 | 看哪个字段 |
|---|---|
| 我答了什么、对不对 | `answers[qid].value` + `content-meta.questions[qid].answer` |
| 我为什么这么答 | `answers[qid].why` |
| 我哪里选错了、为什么 | `answers[qid].wrongReason`（自由文本，需你归类） |
| 我哪里没读懂 | `answers[qid]` 里 `why` 为空 + `doubt` 类标注 / `annotations[].doubt` |
| 我在正文里标了什么 | `annotations[]`（quote 锚点）、`marks[]`（位置锚点） |
| 我手写圈画了什么 | `strokes[]`（`anchor.text` 指出画在哪一段，`color`/`width` 反映圈画重点） |
| 我记了什么笔记/灵感 | `notes[]` |
| 我读到哪了 | `scrollPercent`、`readDone`、`sectionProgress` |
| 哪些该优先复盘 | 自己推导：未作答 + 答错 + 带 `why` + 存疑标注 |

### 4.3 建议给 Agent 的提示词片段

```
这份 HTML 的用户交互数据在文末 <script id="html-quiz-progress"> 块内，
题目与标准答案在 <script id="html-content-meta"> 块内。
请只解析这两块（各一次正则提取 + JSON.parse），不要通读正文。

任务：
1. 用 content-meta.questions 的 answer 与 progress.answers 的 value 判分；
2. 汇总三类待复盘项：答错的题（附 why 与 wrongReason）、用户标记 doubt 的项、没答的题；
3. 对 notes / annotations / marks 做主题聚类，给出分类建议（先给建议标签，不直接改文件）；
4. 若 progress.strokes 非空：按 anchor.text 分组，列出用户手写圈画过的段落（笔画形状不做识别）；
5. 输出：复盘清单 + 分类建议 + 一句总结。
```

---

## 5. 给 AI 生成页面的提示词模板（直接复制用）

```text
请生成一个【单文件 HTML】页面，用途是：{资讯阅读 | 交互式答题}。

硬性要求：
1. 单文件，所有图片用 base64 dataURL 内联，不引用任何外部资源/CDN；
2. 正文放在 <article id="content"> 内；
3. 章节用 <section data-sid="s1" data-stitle="章节名"> 标记；
4. 文件末尾保留这两个空壳，运行时与插件会往里写数据，位置不要动：
   <script id="html-content-meta" type="application/json">{ "title":"…","kind":"…","sections":[],"questions":[] }</script>
   <script id="html-quiz-progress" type="application/json">{ "currentQuestion":1,"answers":{},"scrollY":0,"notes":[],"annotations":[],"marks":[],"strokes":[],"meta":{"schema":"html-quiz-progress/v1"} }</script>
5. 页面末尾内联我提供的 runtime 片段（翻页/图片双击/标记/评注/思路/手写标注/降级/防抖保存）；
6. 顶部注释区写明 AI 提取正则与字段含义（照我给的模板抄）。

答题页额外：
- 题目块写法：<div class="q" data-qid="q1">，选项 <input type="radio" name="q1" value="A">；
- 每题下方留一个 class="q-why" 的可折叠输入框（运行时接管）；
- content-meta.questions 里给出 { id, stem, options, answer, explain }，answer 用选项字母。

资讯页额外：
- 图片统一 <img>，不写 width/height 之外的样式（缩略与双击放大由 runtime 处理）；
- content-meta.sections 列出全部章节 id 与标题。

风格：适配墨水屏与移动端触屏，配色柔和，正文行高宽松，段落最大宽度 42em。
```

---

## 6. 使用者视角的三条提醒

1. **进度是明文**：它就写在 HTML 文件里，跟着 iCloud / NAS 同步。分享这个 HTML = 分享你的笔记与批注。介意的话就别分享带笔记的文件。
2. **别在两台设备同时答题**：插件会提示，但技术上仍可能互相覆盖。养成「一台设备答完再换」的習慣最省心。
3. **删文件就是删干净**：不留附属文件、不留索引。同步软件可能仍保留云端历史版本，那不归插件管。
