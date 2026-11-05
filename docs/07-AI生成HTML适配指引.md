# AI 生成 HTML 适配指引

> 目标：让 AI（或任何脚本）生成的**单文件 HTML**，打开就能用「HTML 单文件视图」插件的全部功能，
> 并且所有交互数据都写回这个文件自己。
>
> 可直接复制的骨架见 [`templates/template-external.html`](../templates/template-external.html)。

---

## 1. 三条硬要求

| # | 要求 | 写法 | 不满足会怎样 |
|---|---|---|---|
| 1 | **正文容器** | `<main id="content">…</main>` | 插件会退到 `<main>` → `<article>` → `<body>`；再不行，标注会锚到导航栏上 |
| 2 | **章节标记** | 章节标题加 `data-sid="唯一 id"` | 没有它就没有「读到第几章」的进度 |
| 3 | **题目标记** | 题目块加 `data-qid="唯一 id"` | 没有它就没有可作答的题目控件 |

**runtime 不需要自己内联** —— 插件打开 HTML 时会自动注入。
（只有想让文件脱离 Obsidian 也带功能时，才需要内联，见 §5。）

---

## 2. 为什么值得按这个规范生成

| 能力 | 依赖 | 说明 |
|---|---|---|
| 翻页键 / 触屏分区翻页 | 无（runtime 自带） | 右侧上下三角；触屏点按上/下半屏翻页，滑动照常滚动 |
| 标注 / 笔记 / 标记 | ① 正文容器 | 选中文字 → 小工具条 → 写批注；锚点落在正文段落上 |
| 手写涂鸦 | 无 | 右下角 ✏️ 进入画笔模式 |
| 阅读进度 / 章节进度 | ① ② | 按 `data-sid` 分章记录 |
| 答题 | ① ③ | 作答写回文件，跨设备接力 |
| 进度回写 | 数据区 | 全部写回这个 HTML 自己，**不产生任何附属文件** |

---

## 3. 给 AI 的提示词模板

复制下面这段，替换 `{{主题}}` 即可：

```text
请生成一个**单文件 HTML 报告**，主题是「{{主题}}」。

硬性要求：
1. 只有一个 .html 文件，图片一律 base64 内联，不引用任何外部资源（零外链）。
2. 正文放在 <main id="content">…</main> 里。
3. 每个章节的标题写成 <h2 data-sid="sec-1">…</h2>（sec-1、sec-2… 递增且唯一）。
4. 每个要作答的题目写成 <div data-qid="q1">…</div>，选项用
   <label><input type="radio" name="q1" value="A"> …</label>。
5. 文件末尾（</body> 之前）留一个空的数据区：
   <script id="html-quiz-progress" type="application/json">
   { "currentQuestion": 0, "answers": {}, "sectionProgress": {}, "notes": [],
     "annotations": [], "marks": [], "strokes": [], "ui": {},
     "meta": { "schema": "html-quiz-progress/v1" } }
   </script>
6. 不要内联任何 runtime 脚本——插件会自动注入。
7. 排版自己写，但不要给 body 设 overflow:hidden / position:fixed，
   滚动容器必须是 body 或 html，否则翻页会失效。
8. 移动端可读：正文用相对字号，留出底部 120px 安全区（右下角有手写按钮）。

内容结构：
- 摘要（3-5 条要点）
- 背景
- 正文分 N 个章节，每章有小标题
- 3 道以上单选/多选题（用于自测）
- 结论与行动项

输出：只给完整 HTML 代码，不要解释。
```

---

## 4. 生成完的自检清单

对着文件查一遍，五条都能过才算合格：

```bash
# 1. 正文容器
grep -c 'id="content"' x.html          # ≥ 1

# 2. 章节标记
grep -o 'data-sid="[^"]*"' x.html | sort -u | wc -l   # ≥ 1

# 3. 题目标记
grep -o 'data-qid="[^"]*"' x.html | sort -u | wc -l   # ≥ 1

# 4. 数据区存在且能解析
python3 -c "
import re,json,sys
s=open('x.html',encoding='utf-8').read()
m=re.search(r'<script id=\"html-quiz-progress\" type=\"application/json\">(.*?)</script>',s,re.S)
assert m, '没有数据区'
json.loads(m.group(1)); print('数据区 OK')
"

# 5. 零外链
grep -Eo 'src="http[^"]*"|href="http[^"]*"' x.html | wc -l   # 应为 0
```

还有两条只能靠眼睛：

- 页面滚动的是 **body 或 html**（不是某个内层 div）
- 底部留了约 120px 空��（右下角的手写按钮不压正文）

---

## 5. 想让文件脱离 Obsidian 也带功能（可选）

插件的 runtime 是公开的一份脚本，模板构建时会把它内联进成品 HTML。
如果你的文件也要在浏览器里直接打开并使用同样的功能，
把 `templates/src/runtime.js` 的内容原样放进 `</body>` 之前的 `<script>` 里即可：

```html
<script>
/* …… templates/src/runtime.js 的全部内容 …… */
</script>
```

注意：

- runtime 里**不含** `</script` 字面量，可以直接内联，不用转义
- 运行时脚本要排在页面自身脚本**之后**（DOM 解析完再跑）
- runtime 会读 `window.__HVV_TOKEN__` 作为消息令牌；
  在 Obsidian 里这个令牌由插件注入，自己内联时留空即可（降级为本地模式）

---

## 6. 常见问题

**Q：我的 HTML 已经有 `<body>` 了，还要包一层 `<main id="content">` 吗？**
要。插件优先认 `#content`；没有的话才退到 `<main>` / `<article>` / `<body>`。
显式写上最稳，也不会让标注锚到导航栏上。

**Q：数据区会被写坏吗？**
不会。插件只原地替换 `<script id="html-quiz-progress">` 里的 JSON，其余字节不动。
合并时按 `id` 合并，删除走「墓碑」，多设备并发改同一份文件不会互相覆盖。

**Q：图片能外链吗？**
不建议。用户硬约束是「单文件、零外链」——外链图片在离线或换设备时可能加载不出来，
而且和外链的图片不在数据区里，跨设备接力不完整。

**Q：页面自带 `position:fixed` 顶栏，会不会被插件的按钮盖住？**
插件的界面元素 z-index 在 60～80 区间，会盖在普通顶栏上面。
如果你的顶栏需要置顶，给它 `z-index: 90` 以上即可。

---

## 7. 相关文档

| 文件 | 内容 |
|---|---|
| [docs/04-HTML模板与数据契约.md](./04-HTML模板与数据契约.md) | 标记采集规范、数据区字段表、AI 取数说明 |
| [docs/01-架构说明.md](./01-架构说明.md) | 三层职责、消息通道、安全模型 |
| [docs/02-实现设计.md](./02-实现设计.md) | 决策总表（为什么这么设计） |
