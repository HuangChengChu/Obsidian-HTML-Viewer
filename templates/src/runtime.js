/* =============================================================================
 * HTML 单文件视图 · 页面运行时
 * -----------------------------------------------------------------------------
 * 职责：
 *   1. 与 Obsidian 插件握手，读取 / 回写进度（唯一真相源 = <script id="html-quiz-progress">）
 *   2. 采集用户产出：答案 / 思路 / 选错原因 / 评注 / 存疑 / 位置标记 / 笔记
 *   3. 章节级阅读进度
 *   4. 交互：悬浮翻页键（40% 透明、可拖动）、图片双击三态、选中文字加批注
 *   5. 降级：不在插件环境时用 localStorage（再不行用内存），并明确告知无法跨设备同步
 *
 * 无外部依赖、无 CDN、无 import —— 可直接内联进任何单文件 HTML。
 * ============================================================================= */
(function () {
  "use strict";

  var PROGRESS_ID = "html-quiz-progress";
  var META_ID = "html-content-meta";
  var VERSION = "1.3.0";

  var MSG = {
    LOAD: "LOAD_PROGRESS",
    SAVE: "SAVE_PROGRESS",
    PROGRESS: "HTML_QUIZ:PROGRESS",
    ACK: "HTML_QUIZ:ACK",
    SELFTEST: "HTML_QUIZ:SELFTEST",
    PROBE: "HTML_QUIZ:PROBE",
    STATE: "STATE_PROBE",
    INK: "HTML_QUIZ:INK",
  };

  var SAVE_DEBOUNCE = 500;
  var HANDSHAKE_TIMEOUT = 600;
  var STORAGE_PREFIX = "html-view-progress:";

  var state = freshState();

  /**
   * 一份干净的进度状态。
   *
   * page 宿主切换 MD 文件时要用它重置——不能把上一篇的答案带到下一篇。
   */
  function freshState() {
    return {
      currentQuestion: 0,
      answers: {},
      scrollY: 0,
      scrollPercent: 0,
      readDone: false,
      sectionProgress: {},
      notes: [],
      annotations: [],
      marks: [],
      strokes: [],
      ui: { pager: { top: 0.5, right: 20 }, inkbar: { edge: "bottom" } },
      meta: {},
    };
  }

  // ---------------------------------------------------------------- 宿主适配层
  //
  // 同一份 runtime 要能跑在两种地方：
  //   iframe 宿主 —— 单文件 HTML 页面（模板页 / 外部网页）
  //   page   宿主 —— Obsidian 主页面里的 MD 阅读视图
  //
  // 两种宿主只有四件事不同：正文根在哪、滚动容器在哪、事件怎么监听、
  // 数据怎么进出。抽成 HOST 之后，下面的业务逻辑一行都不用改。
  //
  // page 宿主是「单实例 + 反复 attach」：Obsidian 可以同时开着好几篇 MD，
  // runtime 只有一个，靠 attachPage() 切换当前服务的那一篇。
  //
  // 宿主信息在 runtime 被注入**之前**由插件写到 window.__HVV_HOST__ 上，
  // 这样 runtime 一跑起来就知道自己是谁。
  var BOOT = window.__HVV_HOST__ || null;

  var HOST = {
    kind: BOOT && BOOT.kind === "page" ? "page" : "iframe",
    root: (BOOT && BOOT.root) || null,
    scroll: (BOOT && BOOT.scroll) || null,
    transport: (BOOT && BOOT.transport) || null,
    paused: false, // 临时关停：所有交互让位
    uiRoot: null, // page 宿主下 runtime 界面元素的专用壳
    prevRoot: null, // 上一次服务的正文根（换篇时要摘掉标记）
  };

  var mode = "unknown"; // unknown | plugin | fallback
  var meta = { questions: [], sections: [], title: "" };
  var TOKEN = window.__HVV_TOKEN__ || "";
  var saveTimer = null;
  var saveStatusTimer = null;
  var memoryFallback = null;
  var sectionRanges = [];
  var lastAnswerSnapshot = {};
  var lastMetaQuestionCount = null;

  // ---------------------------------------------------------------- 宿主适配层
  //
  // 同一份 runtime 要能跑在两种地方：
  //   iframe 宿主 —— 单文件 HTML 页面（模板页 / 外部网页）
  //   page   宿主 —— Obsidian 主页面里的 MD 阅读视图
  //
  // 两种宿主只有四件事不同：正文根在哪、滚动容器在哪、事件怎么监听、
  // 数据怎么进出。抽成 HOST 之后，下面的业务逻辑一行都不用改。
  //
  // page 宿主是「单实例 + 反复 attach」：Obsidian 可以同时开着好几篇 MD，
  // runtime 只有一个，靠 attach() 切换当前服务的那一篇。
  /** 当前正文根（page 宿主由外部指定） */
  function hostRoot() {
    return HOST.root || null;
  }

  /** 事件是否落在当前正文根里（page 宿主用来避免劫持 Obsidian 自己的 UI） */
  function inHostScope(target) {
    if (HOST.kind !== "page") return true;
    // 临时关停：所有交互让位，MD 正文恢复成完全可点选、可编辑
    if (HOST.paused) return false;
    if (!HOST.root) return false;
    if (!target) return false;
    try {
      return HOST.root.contains(target);
    } catch (e) {
      return false;
    }
  }

  /**
   * runtime 自己的界面元素挂在哪。
   *
   * iframe 宿主：直接挂 body。
   * page 宿主：挂一个专用的 wrapper div——
   *   不去动 Obsidian 的 body class（那是人家应用的骨架），
   *   同时把 CSS 变量和 .is-ink 状态都收在这个壳里，不污染 Obsidian 自身样式。
   */
  function hostUiRoot() {
    if (HOST.kind !== "page") return document.body;
    if (!HOST.uiRoot) {
      var d = document.createElement("div");
      d.className = "hvv-page-root";
      d.setAttribute("data-hvv-page-root", "1");
      document.body.appendChild(d);
      HOST.uiRoot = d;
    }
    return HOST.uiRoot;
  }

  /** 焦点是否在当前正文根里（键盘事件用） */
  function hostHasFocus() {
    if (HOST.kind !== "page") return true;
    if (!HOST.root) return false;
    var a = document.activeElement;
    if (!a) return false;
    try {
      return HOST.root.contains(a);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- 工具

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function nowIso() {
    return new Date().toISOString();
  }
  function uid(prefix) {
    return (
      prefix +
      "-" +
      Math.random().toString(36).slice(2, 8) +
      "-" +
      Date.now().toString(36).slice(-4)
    );
  }
  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function storageKey() {
    return STORAGE_PREFIX + (location.pathname || "index");
  }

  // ---------------------------------------------------------------- 样式注入

  var CSS = [
    ".hvv-root{--hvv-accent:#4a7bd5;--hvv-mark:rgba(255,214,102,.38);--hvv-ink:#1f2328;}",
    "@media (prefers-color-scheme: dark){.hvv-root{--hvv-ink:#e6e9ee;}}",
    // 绝不改动页面自己的排版：只约束 runtime 自己的界面元素
    // （模板页自己就设了 * { box-sizing:border-box }，不需要我们代劳）
    ".hvv-root :is(.hvv-banner *,.hvv-status *,.hvv-pager *,.hvv-seltool *,.hvv-pop *,.hvv-dialog *,.hvv-inkbar *,.hvv-overlay *,.hvv-zone *){box-sizing:border-box;}",
    ".hvv-banner{position:sticky;top:0;z-index:60;display:none;padding:8px 12px;font-size:13px;line-height:1.6;",
    "background:rgba(255,196,64,.16);border-bottom:1px solid rgba(0,0,0,.12);color:#5a4a10;}",
    ".hvv-banner.is-on{display:block;}",
    ".hvv-banner.is-error{background:rgba(230,70,70,.14);color:#8a1f1f;}",
    ".hvv-status{position:fixed;left:16px;bottom:12px;z-index:70;",
    "padding:2px 9px;border-radius:999px;font-size:11px;background:rgba(0,0,0,.3);color:rgba(255,255,255,.92);",
    "opacity:0;transition:opacity .3s;pointer-events:none;}",
    ".hvv-status.is-on{opacity:.5;}",
    ".hvv-status.is-error{background:rgba(190,40,40,.5);opacity:.95;}",
    ".hvv-pager{position:fixed;z-index:55;right:20px;top:50%;display:flex;flex-direction:column;",
    "gap:44px;transform:translateY(-50%);opacity:.4;transition:opacity .2s;touch-action:none;}",
    ".hvv-pager.is-active{opacity:.85;}",
    ".hvv-pager-btn{width:36px;height:36px;border-radius:50%;border:1px solid rgba(0,0,0,.25);",
    "background:rgba(255,255,255,.9);color:#333;font-size:15px;line-height:1;cursor:pointer;",
    "box-shadow:0 1px 4px rgba(0,0,0,.18);padding:0;}",
    ".hvv-pager-btn:active{background:#eee;}",
    ".hvv-seltool{position:absolute;z-index:65;display:none;gap:4px;padding:4px;border-radius:8px;",
    "background:#fff;border:1px solid rgba(0,0,0,.16);box-shadow:0 4px 14px rgba(0,0,0,.18);}",
    ".hvv-seltool.is-on{display:flex;}",
    ".hvv-seltool button{border:1px solid rgba(0,0,0,.15);background:#fafafa;border-radius:6px;",
    "padding:4px 8px;font-size:12px;cursor:pointer;}",
    ".hvv-pop{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:80;width:min(520px,92vw);",
    "padding:14px;border-radius:12px;background:var(--hvv-panel,#fff);border:1px solid rgba(0,0,0,.16);",
    "box-shadow:0 12px 40px rgba(0,0,0,.26);display:none;}",
    ".hvv-pop.is-on{display:block;}",
    ".hvv-pop h4{margin:0 0 8px;font-size:14px;}",
    ".hvv-pop textarea{width:100%;min-height:84px;font:inherit;font-size:13px;padding:8px;",
    "border-radius:8px;border:1px solid rgba(0,0,0,.2);resize:vertical;}",
    ".hvv-pop-row{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;}",
    ".hvv-pop-actions{margin-top:10px;display:flex;gap:8px;justify-content:flex-end;}",
    ".hvv-pop-actions button{padding:5px 14px;border-radius:7px;border:1px solid rgba(0,0,0,.18);",
    "background:#f3f3f3;cursor:pointer;font-size:13px;}",
    ".hvv-pop-actions .hvv-ok{background:var(--hvv-accent,#4a7bd5);color:#fff;border-color:transparent;}",
    ".hvv-overlay{position:fixed;inset:0;z-index:90;display:none;align-items:center;justify-content:center;",
    "background:rgba(0,0,0,.86);}",
    ".hvv-overlay.is-on{display:flex;}",
    ".hvv-overlay img{max-width:100%;max-height:100%;object-fit:contain;}",
    ".hvv-overlay.is-fit img{width:100vw;height:auto;max-height:100vh;}",
    ".hvv-overlay.is-full img{width:100vw;height:100vh;max-height:none;object-fit:contain;}",
    ".hvv-overlay-hint{position:absolute;top:12px;right:16px;color:#fff;opacity:.6;font-size:12px;}",
    // 笔记与标注改成「右侧贴边的悬浮面板」：
    // 常驻在页面流里会挤占正文宽度（网格布局的页面甚至会被排到右列去），
    // 所以它必须脱离文档流，用 fixed 定位，关闭时完全不占地方。
    ".hvv-panel{position:fixed;top:0;right:0;height:100%;width:min(380px,88vw);z-index:79;",
    "background:var(--hvv-panel-bg,#fff);border-left:1px solid rgba(0,0,0,.14);",
    "box-shadow:-8px 0 28px rgba(0,0,0,.14);transform:translateX(102%);",
    "transition:transform .18s ease;display:flex;flex-direction:column;",
    "font-size:13px;line-height:1.7;overflow:hidden;}",
    ".hvv-panel.is-on{transform:none;}",
    "@media (prefers-color-scheme: dark){.hvv-panel{--hvv-panel-bg:#1e2126;}}",
    ".hvv-panel-head{display:flex;align-items:center;gap:8px;padding:12px 14px;",
    "border-bottom:1px solid rgba(0,0,0,.1);flex:0 0 auto;}",
    ".hvv-panel-head h3{margin:0;font-size:15px;flex:1;}",
    ".hvv-panel-close{border:1px solid rgba(0,0,0,.15);background:#fafafa;border-radius:7px;",
    "width:28px;height:28px;line-height:1;cursor:pointer;font-size:14px;}",
    ".hvv-panel-body{flex:1 1 auto;overflow:auto;padding:12px 14px 24px;}",
    // 面板把手：右侧贴边的一条窄条，不碰翻页键（翻页键 right:20px）和手写按钮
    ".hvv-panel-tab{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:58;",
    "width:18px;padding:14px 0;border:1px solid rgba(0,0,0,.14);border-right:none;",
    "border-radius:8px 0 0 8px;background:rgba(255,255,255,.72);color:#444;cursor:pointer;",
    "writing-mode:vertical-rl;letter-spacing:1px;font-size:12px;opacity:.5;",
    "transition:opacity .2s;}",
    ".hvv-panel-tab:hover,.hvv-panel-tab:focus-visible{opacity:.95;}",
    // 面板打开时，把手挪到面板左边缘当关闭钮（点一下就收起）
    ".hvv-panel.is-on ~ .hvv-panel-tab{right:min(380px,88vw);opacity:.95;pointer-events:auto;}",
    ".hvv-zone{padding:0;}",
    ".hvv-zone-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}",
    ".hvv-zone-actions button{padding:5px 12px;border-radius:8px;border:1px solid rgba(0,0,0,.18);",
    "background:#f5f5f5;cursor:pointer;font-size:13px;}",
    ".hvv-zone-list{display:flex;flex-direction:column;gap:8px;}",
    ".hvv-item{border:1px solid rgba(0,0,0,.12);border-radius:9px;padding:8px 10px;background:rgba(0,0,0,.02);}",
    ".hvv-item.is-doubt{border-left:3px solid #e08a2e;}",
    ".hvv-item-text{white-space:pre-wrap;word-break:break-word;}",
    ".hvv-item-quote{color:#777;font-size:12px;margin-top:4px;white-space:pre-wrap;word-break:break-word;}",
    ".hvv-item-meta{margin-top:4px;font-size:11px;color:#999;display:flex;gap:8px;align-items:center;}",
    ".hvv-item-meta button{border:none;background:none;color:var(--hvv-accent,#4a7bd5);cursor:pointer;",
    "font-size:11px;padding:0;}",
    ".hvv-empty{color:#999;font-size:12px;}",
    ".hvv-img{cursor:zoom-in;}",
    "mark.hvv-annot{background:var(--hvv-mark,rgba(255,214,102,.38));color:inherit;",
    "border-bottom:1px dashed rgba(160,120,0,.5);}",
    ".hvv-marked{border-left:3px solid var(--hvv-accent,#4a7bd5);padding-left:10px;}",
    ".hvv-q-judge{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:999px;font-size:12px;}",
    ".hvv-q-judge.is-ok{background:rgba(40,160,90,.16);color:#1e7a45;}",
    ".hvv-q-judge.is-no{background:rgba(200,60,60,.14);color:#b03434;}",
    ".hvv-q-doubt{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:12px;",
    "background:rgba(224,138,46,.18);color:#96591a;}",
    /* ---------- 手写标注层 ---------- */
    ".hvv-ink{position:absolute;left:0;top:0;width:100%;height:100%;z-index:5;pointer-events:none;touch-action:none;}",
    ".hvv-root.is-ink .hvv-ink{pointer-events:auto;}",
    ".hvv-root.is-ink .hvv-content-root{user-select:none;-webkit-user-select:none;}",
    ".hvv-ink path{fill:none;stroke-linecap:round;stroke-linejoin:round;}",
    ".hvv-ink-zoomspace{height:0;}",
    ".hvv-ink-fab{position:fixed;right:18px;bottom:18px;z-index:78;width:44px;height:44px;border-radius:50%;",
    "border:1px solid rgba(0,0,0,.2);background:rgba(255,255,255,.94);color:#333;font-size:20px;line-height:1;",
    "cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2);padding:0;}",
    ".hvv-ink-fab.is-on{background:var(--hvv-accent,#4a7bd5);color:#fff;border-color:transparent;}",
    // 「静止的悬浮开关」：常驻右下角、在触笔按钮正上方，不随页面滚动。
    // 点一下临时关停插件（MD 正文就能正常选中和编辑了），再点一下恢复。
    ".hvv-halt{position:fixed;right:18px;bottom:70px;z-index:78;width:44px;height:44px;border-radius:50%;",
    "border:1px solid rgba(0,0,0,.2);background:rgba(255,255,255,.94);color:#333;font-size:17px;line-height:1;",
    "cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2);padding:0;}",
    ".hvv-halt.is-paused{background:var(--hvv-accent,#4a7bd5);color:#fff;border-color:transparent;}",
    // 临时关停：runtime 的界面全部让位，只有开关按钮自己还能点
    ".hvv-root.is-paused :is(.hvv-pager,.hvv-panel,.hvv-panel-tab,.hvv-ink-fab,.hvv-inkbar,",
    ".hvv-brushgrid,.hvv-overlay,.hvv-pop,.hvv-seltool,.hvv-zoomtag,.hvv-status){pointer-events:none;opacity:.18;}",
    ".hvv-root.is-paused .hvv-halt{pointer-events:auto;opacity:1;}",
    ".hvv-inkbar{position:fixed;z-index:79;display:none;align-items:center;gap:4px;padding:5px;border-radius:12px;",
    "background:rgba(255,255,255,.96);border:1px solid rgba(0,0,0,.16);box-shadow:0 4px 18px rgba(0,0,0,.2);",
    "touch-action:none;}",
    ".hvv-inkbar.is-on{display:flex;}",
    ".hvv-inkbar.is-v{flex-direction:column;}",
    ".hvv-inkbar button{min-width:32px;height:32px;border-radius:8px;border:1px solid rgba(0,0,0,.14);",
    "background:#f5f5f5;cursor:pointer;font-size:15px;line-height:1;padding:0 6px;}",
    ".hvv-inkbar button.is-on{background:var(--hvv-accent,#4a7bd5);color:#fff;border-color:transparent;}",
    ".hvv-inkbar .hvv-grip{cursor:grab;user-select:none;color:#888;font-size:15px;padding:0 4px;}",
    ".hvv-brushgrid{position:fixed;z-index:81;display:none;grid-template-columns:repeat(3,1fr);gap:6px;padding:8px;",
    "border-radius:12px;background:#fff;border:1px solid rgba(0,0,0,.16);box-shadow:0 6px 20px rgba(0,0,0,.24);}",
    ".hvv-brushgrid.is-on{display:grid;}",
    ".hvv-brushgrid .hvv-swatch{width:30px;height:30px;border-radius:50%;border-style:solid;cursor:pointer;",
    "border-color:rgba(0,0,0,.25);padding:0;}",
    ".hvv-brushgrid .hvv-swatch.is-on{outline:2px solid var(--hvv-accent,#4a7bd5);outline-offset:2px;}",
    ".hvv-zoomtag{position:fixed;top:12px;right:16px;z-index:78;display:none;align-items:center;gap:6px;",
    "padding:4px 8px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;font-size:12px;}",
    ".hvv-zoomtag.is-on{display:flex;}",
    ".hvv-zoomtag button{border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:999px;",
    "padding:2px 8px;font-size:11px;cursor:pointer;}",
    ".hvv-dialog{position:fixed;left:50%;bottom:60px;transform:translateX(-50%);z-index:82;",
    "width:min(460px,92vw);padding:14px;border-radius:12px;background:var(--hvv-panel,#fff);",
    "border:1px solid rgba(0,0,0,.16);box-shadow:0 12px 40px rgba(0,0,0,.26);display:none;}",
    ".hvv-dialog.is-on{display:block;}",
    ".hvv-dialog h4{margin:0 0 8px;font-size:14px;}",
    ".hvv-dlg-msg{font-size:13px;line-height:1.6;color:#555;}",
    ".hvv-dlg-actions{margin-top:12px;display:flex;gap:8px;justify-content:flex-end;}",
    ".hvv-dlg-actions button{padding:5px 14px;border-radius:7px;border:1px solid rgba(0,0,0,.18);",
    "background:#f3f3f3;cursor:pointer;font-size:13px;}",
    ".hvv-dlg-actions .hvv-ok{background:var(--hvv-accent,#4a7bd5);color:#fff;border-color:transparent;}",
    ".hvv-zone-sum{font-size:12px;color:#888;margin:0 0 10px;}",
    "@media (prefers-contrast: more){.hvv-annot{background:rgba(255,214,102,.6);}}",
  ].join("");

  function injectStyles() {
    var style = document.createElement("style");
    style.setAttribute("data-hvv-style", "1");
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- 消息通道

  function post(type, payload) {
    if (mode === "fallback") return;
    // page 宿主：直接交给宿主（Obsidian 侧），不走 postMessage
    if (HOST.transport) {
      try {
        HOST.transport.post(type, payload);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    try {
      window.parent.postMessage(
        { type: type, payload: payload, token: TOKEN },
        "*",
      );
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 处理来自宿主的指令（与「消息来自哪个窗口」无关，只看类型和内容）。
   *
   * iframe 宿主：window "message" 事件 → onMessage → 这里
   * page 宿主：宿主直接调用 → 这里
   */
  function handleIncoming(type, rawPayload) {
    var p = isPlainObject(rawPayload) ? rawPayload : {};
    var inner = isPlainObject(p.payload) ? p.payload : p;
    if (type === MSG.PROGRESS) {
      enterPluginMode();
      applyProgress(inner);
      return;
    }
    if (type === MSG.ACK) {
      var ack = isPlainObject(p.payload) ? p.payload : {};
      if (!ack.ok) {
        // 成功不再弹提示：插件底栏已经显示「已保存于 HH:MM:SS」
        showStatus("保存失败：" + (ack.error || "未知错误"), true);
      }
      return;
    }
    if (type === MSG.SELFTEST) {
      // 自检请求是单层载荷（PROGRESS 才是双层包裹的）
      runSelftest(p);
      return;
    }
    if (type === MSG.PROBE) {
      post(MSG.STATE, collectPayload());
      return;
    }
  }

  function onMessage(event) {
    var data = event.data;
    if (!isPlainObject(data) || typeof data.type !== "string") return;
    // 页面侧也校验令牌（插件注入时才有）
    if (TOKEN && data.token !== TOKEN) return;
    handleIncoming(data.type, data.payload);
  }

  function enterPluginMode() {
    if (mode === "plugin") return;
    mode = "plugin";
    hideBanner();
    // 若降级期间攒了本地进度，合并后立即写回
    var local = readLocal();
    if (local && Object.keys(local).length) {
      mergeLocal(local);
    }
  }

  // ---------------------------------------------------------------- 握手

  function startHandshake() {
    // page 宿主：进度由宿主直接送进来（attach 时给），不需要握手
    if (HOST.kind === "page") {
      mode = "plugin";
      return;
    }
    if (window.parent === window) {
      enterFallbackMode("当前不在自定义 HTML 视图，进度无法跨设备同步");
      return;
    }
    post(MSG.LOAD);
    window.setTimeout(function () {
      if (mode !== "plugin") {
        enterFallbackMode("当前不在自定义 HTML 视图，进度无法跨设备同步");
      }
    }, HANDSHAKE_TIMEOUT);
  }

  function enterFallbackMode(reason) {
    if (mode === "fallback") return;
    mode = "fallback";
    showBanner(reason + "（本次改动只保存在本机）");
    var local = readLocal();
    if (local) applyProgress(local);
  }

  function readLocal() {
    try {
      var raw = window.localStorage.getItem(storageKey());
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
    } catch (e) {
      if (memoryFallback) {
        try {
          return JSON.parse(memoryFallback);
        } catch (e2) {
          return null;
        }
      }
      return null;
    }
  }

  function writeLocal(payload) {
    var text = JSON.stringify(payload);
    try {
      window.localStorage.setItem(storageKey(), text);
      return true;
    } catch (e) {
      memoryFallback = text;
      return false;
    }
  }

  function mergeLocal(local) {
    var answers = Object.assign({}, local.answers || {}, state.answers || {});
    var payload = Object.assign({}, local, {
      answers: answers,
      notes: (local.notes || []).concat(state.notes || []),
      annotations: (local.annotations || []).concat(state.annotations || []),
      marks: (local.marks || []).concat(state.marks || []),
      strokes: (local.strokes || []).concat(state.strokes || []),
    });
    state.notes = dedupeById(payload.notes);
    state.annotations = dedupeById(payload.annotations);
    state.marks = dedupeById(payload.marks);
    state.strokes = dedupeById(payload.strokes);
    state.answers = answers;
    renderZone();
    inkRender();
    saveNow();
  }

  function dedupeById(list) {
    var map = {};
    (list || []).forEach(function (item) {
      if (!isPlainObject(item)) return;
      var id = item.id || uid("x");
      item.id = id;
      map[id] = item;
    });
    return Object.keys(map).map(function (k) {
      return map[k];
    });
  }

  /**
   * 页面的滚动宿主。
   *
   * 默认是 window（模板页和绝大多数页面都是）。
   * 有些网页用自定义容器滚动（body 之外的一个 div），
   * 那种情况下翻页要滚那个容器，锚点换算也得用它的 scrollTop。
   *
   * 返回 null 表示「用 window」。
   * 查找范围刻意收窄：整页 querySelectorAll("*") 在几 MB 的页面上太慢，
   * 只看常见的内容/滚动容器选择器，命中不了就老老实实用 window。
   */
  var scrollHostCache;

  function scrollHost() {
    // page 宿主：滚动容器由宿主指定（Obsidian 的阅读视图自己滚）
    if (HOST.kind === "page") return HOST.scroll || null;
    if (scrollHostCache !== undefined) return scrollHostCache;
    scrollHostCache = null;
    try {
      var se = document.scrollingElement;
      // window 自己能滚 → 用 window（最常见的情况）
      if (!se || se.scrollHeight <= se.clientHeight + 4) {
        var cands = document.querySelectorAll(
          "main,article,#content,.content,.main,.main-content,.scroll,.scroll-wrap,.doc,.doc-body,.markdown-body,#markdown-body",
        );
        for (var i = 0; i < cands.length; i++) {
          var c = cands[i];
          if (c.scrollHeight <= c.clientHeight + 4) continue;
          var st = window.getComputedStyle(c);
          if (!/(auto|scroll|overlay)/.test(st.overflowY + st.overflow)) continue;
          if (st.position === "fixed") continue;
          scrollHostCache = c;
          break;
        }
      }
    } catch (err) {
      scrollHostCache = null;
    }
    return scrollHostCache;
  }

  /** 当前滚动位置（不管滚的是 window 还是自定义容器） */
  function scrollTop() {
    var h = scrollHost();
    return h ? h.scrollTop : window.scrollY || window.pageYOffset || 0;
  }

  /**
   * 在「瞬时滚动」的前提下执行一段滚动操作。
   *
   * 很多普通网页自带 `html { scroll-behavior: smooth }`，
   * 这会让 scrollTop 赋值和 scrollTo 也变成动画 —— 翻页在墨水屏上是硬伤。
   * 所以先把滚动元素的 scroll-behavior 临时压成 auto，滚完再还原。
   */
  function withInstantScroll(el, fn) {
    var prev = "";
    var patched = false;
    try {
      if (el && el.style) {
        prev = el.style.scrollBehavior || "";
        el.style.scrollBehavior = "auto";
        patched = true;
      }
    } catch (e) {
      /* 拿不到 style 就退回原生行为 */
    }
    try {
      fn();
    } finally {
      try {
        if (patched) el.style.scrollBehavior = prev;
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 滚到指定位置（smooth=true 时平滑滚动，默认瞬时——墨水屏不要动画） */
  function scrollToPos(y, smooth) {
    var h = scrollHost();
    if (smooth) {
      if (h) h.scrollTo({ top: y, behavior: "smooth" });
      else window.scrollTo({ top: y, behavior: "smooth" });
      return;
    }
    withInstantScroll(h || document.scrollingElement || document.documentElement, function () {
      // behavior: "instant" 显式盖过页面自己的 scroll-behavior；
      // 万一浏览器不认这个值，withInstantScroll 的 auto 兜底也拦得住动画。
      if (h) h.scrollTop = y;
      else window.scrollTo({ top: y, behavior: "instant" });
    });
  }

  /** 相对滚动 */
  function scrollByPos(dy) {
    var h = scrollHost();
    withInstantScroll(h || document.scrollingElement || document.documentElement, function () {
      if (h) h.scrollTop += dy;
      else window.scrollBy({ top: dy, behavior: "instant" });
    });
  }

  /** 可视高度（滚动视口） */
  function viewportHeight() {
    var h = scrollHost();
    return h ? h.clientHeight : window.innerHeight;
  }

  // ---------------------------------------------------------------- 采集

  /**
   * 正文根元素。
   *
   * 模板页用 `#content`；用户从外面拿来的普通网页不一定有，
   * 这时依次退到 `main` → `article` → `body`，
   * 保证翻页、标注、手写这些功能在没有 #content 的文件里也能用。
   */
  function contentRoot() {
    // page 宿主：正文根由宿主指定（MD 阅读视图容器）
    if (HOST.kind === "page") return HOST.root || document.body;
    return $("#content") || $("main") || $("article") || document.body;
  }

  /**
   * 在正文根里查元素。
   *
   * 退到 body 时要排除导航/页眉页脚里的元素——
   * 否则标注会锚到目录条目上，而不是正文段落。
   */
  function contentEls(sel) {
    var root = contentRoot();
    var list = Array.prototype.slice.call(root.querySelectorAll(sel));
    if (root !== document.body) return list;
    return list.filter(function (el) {
      return !el.closest(
        "nav,aside,header,footer,.sidebar,.toc,#toc,.hvv-pager,.hvv-ink-fab," +
          ".hvv-inkbar,.hvv-pop,.hvv-dialog,.hvv-seltool,.hvv-zone,.hvv-panel,.hvv-panel-tab,.hvv-overlay",
      );
    });
  }

  function contentEl() {
    return contentRoot();
  }

  function questionBlocks() {
    return $$("[data-qid]");
  }

  function readValue(block, qid) {
    var all = $$('input[type="radio"], input[type="checkbox"]', block);
    // 只认 name === qid 的输入；否则退回「除 q-doubt 外的所有勾选项」
    var matched = all.filter(function (i) {
      return i.name === qid;
    });
    var pool = matched.length
      ? matched
      : all.filter(function (i) {
          return !i.classList.contains("q-doubt");
        });
    var checked = pool.filter(function (i) {
      return i.checked;
    });
    if (checked.length === 0) return undefined;
    if (checked.length === 1) return checked[0].value;
    return checked.map(function (i) {
      return i.value;
    });
  }

  function collectAnswers() {
    var answers = {};
    questionBlocks().forEach(function (block) {
      var qid = block.getAttribute("data-qid");
      if (!qid) return;
      var value = readValue(block, qid);
      var whyEl = $(".q-why", block);
      var wrongEl = $(".q-wrong-reason", block);
      var doubtEl = $(".q-doubt", block);
      var why = whyEl ? whyEl.value.trim() : "";
      var wrongReason = wrongEl ? wrongEl.value.trim() : "";
      var doubt = !!(doubtEl && doubtEl.checked);
      var prev = state.answers[qid] || {};
      var prevValue = prev.value === undefined ? undefined : prev.value;
      var same =
        JSON.stringify(prevValue) === JSON.stringify(value) &&
        (prev.why || "") === why &&
        (prev.wrongReason || "") === wrongReason &&
        (prev.doubt === true) === doubt;
      if (value === undefined && !why && !wrongReason && !doubt) {
        delete answers[qid];
        return;
      }
      var entry = {};
      if (value !== undefined) entry.value = value;
      if (why) entry.why = why;
      if (wrongReason) entry.wrongReason = wrongReason;
      if (doubt) entry.doubt = true;
      entry.at = same && prev.at ? prev.at : nowIso();
      answers[qid] = entry;
    });
    return answers;
  }

  function collectPayload() {
    var answers = collectAnswers();
    state.answers = answers;
    var y = scrollTop();
    var max =
      Math.max(
        1,
        (document.documentElement.scrollHeight || 1) - window.innerHeight,
      );
    state.scrollY = Math.round(y);
    state.scrollPercent = Math.min(100, Math.round((y / max) * 100));
    updateSectionProgress();

    return {
      currentQuestion: state.currentQuestion,
      answers: answers,
      scrollY: state.scrollY,
      scrollPercent: state.scrollPercent,
      readDone: state.readDone,
      sectionProgress: state.sectionProgress,
      notes: state.notes,
      annotations: state.annotations,
      marks: state.marks,
      strokes: state.strokes.map(inkStrokeToPersist),
      ui: state.ui,
      meta: state.meta || {},
    };
  }

  // ---------------------------------------------------------------- 保存

  function scheduleSave() {
    // 手写期间不触发自动保存：涂鸦只在点「保存涂鸦」时写盘
    if (ink.active) return;
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE);
  }

  function saveNow() {
    var payload = collectPayload();
    if (mode === "plugin") {
      post(MSG.SAVE, payload);
    } else {
      // 降级模式：顶部横幅已经说明「只保存在本机」，不再用弹窗重复提示
      var ok = writeLocal(payload);
      if (!ok) showStatus("已保存在内存（本次会话有效）", true);
    }
  }

  // ---------------------------------------------------------------- 恢复

  function applyProgress(payload) {
    if (!isPlainObject(payload)) return;

    var answers = isPlainObject(payload.answers) ? payload.answers : {};
    questionBlocks().forEach(function (block) {
      var qid = block.getAttribute("data-qid");
      if (!qid) return;
      var entry = answers[qid];
      if (entry === undefined) return;
      var value =
        isPlainObject(entry) && "value" in entry ? entry.value : entry;
      var vals =
        value === undefined ? [] : Array.isArray(value) ? value : [value];
      $$('input[type="radio"], input[type="checkbox"]', block).forEach(
        function (input) {
          input.checked = vals.indexOf(input.value) >= 0;
        },
      );
      if (isPlainObject(entry)) {
        var whyEl = $(".q-why", block);
        if (whyEl && typeof entry.why === "string") whyEl.value = entry.why;
        var wrongEl = $(".q-wrong-reason", block);
        if (wrongEl && typeof entry.wrongReason === "string") {
          wrongEl.value = entry.wrongReason;
        }
        var doubtEl = $(".q-doubt", block);
        if (doubtEl && entry.doubt === true) doubtEl.checked = true;
      }
    });
    state.answers = {};
    state.answers = collectAnswers();

    state.currentQuestion =
      typeof payload.currentQuestion === "number" ? payload.currentQuestion : 0;
    state.notes = Array.isArray(payload.notes) ? payload.notes : [];
    state.annotations = Array.isArray(payload.annotations)
      ? payload.annotations
      : [];
    state.marks = Array.isArray(payload.marks) ? payload.marks : [];
    state.strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
    state.sectionProgress = isPlainObject(payload.sectionProgress)
      ? payload.sectionProgress
      : {};
    state.readDone = payload.readDone === true;
    if (isPlainObject(payload.ui) && isPlainObject(payload.ui.pager)) {
      // 旧格式 {x,y}：x 是距右像素、y 是距底像素 → 迁移成「垂直居中 + 距右」
      state.ui.pager = {
        top:
          typeof payload.ui.pager.top === "number"
            ? payload.ui.pager.top
            : 0.5,
        right:
          typeof payload.ui.pager.right === "number"
            ? payload.ui.pager.right
            : typeof payload.ui.pager.x === "number"
              ? payload.ui.pager.x
              : 20,
      };
    }
    if (isPlainObject(payload.ui) && isPlainObject(payload.ui.inkbar)) {
      state.ui.inkbar = {
        edge: String(payload.ui.inkbar.edge || "bottom"),
      };
    }
    if (isPlainObject(payload.meta)) {
      state.meta = payload.meta;
    }

    renderZone();
    applyPagerPosition();
    applyMarks();
    updateJudges();
    inkApplyBarEdge((state.ui.inkbar && state.ui.inkbar.edge) || "bottom");
    inkRender();

    window.requestAnimationFrame(function () {
      // 重排校正：笔迹按所属段落的新位置整体平移
      if (ink.zoom === 1 && state.strokes.length) {
        inkApplyReflow();
        inkRender();
      }
      if (typeof payload.scrollY === "number" && payload.scrollY > 0) {
        scrollToPos(payload.scrollY);
      }
      updateCurrentQuestion();
      updateSectionProgress();
    });
  }

  // ---------------------------------------------------------------- 章节

  function computeSections() {
    var explicit = $$("[data-sid]");
    if (explicit.length > 0) {
      return explicit.map(function (el, i) {
        return {
          id: el.getAttribute("data-sid") || "s" + (i + 1),
          title:
            el.getAttribute("data-stitle") ||
            (el.textContent || "").trim().slice(0, 40) ||
            "章节 " + (i + 1),
          startEl: el,
          endEl: el,
        };
      });
    }
    var heads = contentEls("h2, h3");
    var root = contentEl();
    var lastEl = root.lastElementChild || root;
    return heads.map(function (h, i) {
      var next = heads[i + 1];
      var endEl = lastEl;
      if (next) {
        endEl = next.previousElementSibling || next;
      }
      return {
        id: "auto-" + (i + 1),
        title: (h.textContent || "").trim() || "章节 " + (i + 1),
        startEl: h,
        endEl: endEl,
      };
    });
  }

  function updateSectionProgress() {
    if (!sectionRanges.length) sectionRanges = computeSections();
    var y = scrollTop();
    var vh = window.innerHeight;
    var changed = false;
    sectionRanges.forEach(function (r) {
      if (!r.startEl || !r.endEl) return;
      var top = r.startEl.getBoundingClientRect().top + y;
      var bottom = r.endEl.getBoundingClientRect().bottom + y;
      var height = Math.max(1, bottom - top);
      var pct = Math.min(
        100,
        Math.max(0, Math.round(((y + vh - top) / height) * 100)),
      );
      var prev = state.sectionProgress[r.id] || {};
      var passed = y + vh >= bottom - 4;
      var read = prev.read === true || passed;
      if (prev.read !== read || prev.percent !== pct) changed = true;
      state.sectionProgress[r.id] = {
        title: r.title,
        percent: pct,
        read: read,
        at: read && prev.read !== true ? nowIso() : prev.at || nowIso(),
      };
    });
    var max =
      Math.max(
        1,
        (document.documentElement.scrollHeight || 1) - window.innerHeight,
      );
    var percent = Math.min(100, Math.round((y / max) * 100));
    var done = state.readDone;
    if (percent >= 95) done = true;
    if (done !== state.readDone) changed = true;
    state.readDone = done;
    return changed;
  }

  function updateCurrentQuestion() {
    var blocks = questionBlocks();
    if (!blocks.length) return;
    var y = scrollTop();
    var current = 0;
    blocks.forEach(function (b, i) {
      var top = b.getBoundingClientRect().top + y;
      if (top <= y + window.innerHeight * 0.4) current = i;
    });
    state.currentQuestion = current;
  }

  // ---------------------------------------------------------------- 交互面板

  /**
   * 笔记与标注面板。
   *
   * 早先它是插在正文根后面的一个 section（属于文档流），
   * 在网格布局的页面上会被排到右边那一列去，硬生生占掉三分之一宽度。
   * 现在改成脱离文档流的 fixed 悬浮面板：收起时完全不占地方，
   * 右边留一条窄把手，点开才滑出来。
   */
  function ensureZone() {
    var zone = $("#html-interaction-zone");
    if (!zone) {
      zone = document.createElement("section");
      zone.id = "html-interaction-zone";
      hostUiRoot().appendChild(zone);
    } else if (zone.parentNode !== document.body) {
      // 旧版模板在正文流里预留了这个占位，挪到 body 下：
      // 面板要脱离文档流，不能留在正文里（否则会被页面的网格排到右列去）
      hostUiRoot().appendChild(zone);
    }
    // 注意：只能「缺了才加」，不能整个 className 覆盖——
    // 覆盖会把 is-on（展开态）一起抹掉，开关就失灵了
    if (!zone.classList.contains("hvv-panel")) zone.classList.add("hvv-panel");
    if (!$("[data-hvv-zone-sum]", zone)) {
      zone.innerHTML =
        '<div class="hvv-panel-head">' +
        '<h3>我的笔记与标注</h3>' +
        '<button class="hvv-panel-close" data-hvv-panel-close aria-label="关闭面板">✕</button>' +
        '</div>' +
        '<div class="hvv-panel-body">' +
        '<div class="hvv-zone">' +
        '<div class="hvv-zone-sum" data-hvv-zone-sum></div>' +
        '<div class="hvv-zone-actions">' +
        '<button data-hvv-act="note">＋ 新笔记</button>' +
        '<button data-hvv-act="mark">📍 标记此处</button>' +
        '<button data-hvv-act="save">保存进度</button>' +
        '</div>' +
        '<div class="hvv-zone-list"></div>' +
        '</div>' +
        '</div>';
    }
    if (!$("[data-hvv-panel-tab]")) {
      var tab = document.createElement("button");
      tab.className = "hvv-panel-tab";
      tab.setAttribute("data-hvv-panel-tab", "1");
      tab.setAttribute("aria-label", "打开笔记与标注");
      tab.textContent = "笔记";
      hostUiRoot().appendChild(tab);
    }
    return zone;
  }

  function openPanel() {
    var zone = ensureZone();
    zone.classList.add("is-on");
    var tab = document.querySelector("[data-hvv-panel-tab]");
    if (tab) tab.textContent = "✕";
    var list = $(".hvv-zone-list", zone);
    if (list) list.scrollTop = 0;
  }

  function closePanel() {
    var zone = ensureZone();
    zone.classList.remove("is-on");
    var tab = document.querySelector("[data-hvv-panel-tab]");
    if (tab) tab.textContent = "笔记";
  }

  function togglePanel() {
    var zone = ensureZone();
    if (zone.classList.contains("is-on")) closePanel();
    else openPanel();
  }

  function renderZone() {
    var zone = ensureZone();
    var list = $(".hvv-zone-list", zone);
    if (!list) return;
    var sum = $("[data-hvv-zone-sum]", zone);
    if (sum) {
      var alive = 0;
      state.strokes.forEach(function (s) {
        if (!s.deleted) alive++;
      });
      sum.textContent =
        "手写标注 " + alive + " 笔" +
        (ink.draft.length ? "（另有 " + ink.draft.length + " 笔临时草稿未保存）" : "");
    }
    list.innerHTML = "";
    var rows = [];
    state.annotations.forEach(function (a) {
      rows.push({ kind: "评注", item: a, cls: a.doubt ? " is-doubt" : "" });
    });
    state.marks.forEach(function (m) {
      rows.push({ kind: "标记", item: m, cls: m.doubt ? " is-doubt" : "" });
    });
    state.notes.forEach(function (n) {
      rows.push({ kind: "笔记", item: n, cls: "" });
    });
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.className = "hvv-empty";
      empty.textContent = "还没有笔记或标注。选中正文文字可加评注/存疑。";
      list.appendChild(empty);
      return;
    }
    rows.sort(function (a, b) {
      return String(b.item.at || "").localeCompare(String(a.item.at || ""));
    });
    rows.forEach(function (row) {
      var item = row.item;
      var el = document.createElement("div");
      el.className = "hvv-item" + row.cls;
      var text = document.createElement("div");
      text.className = "hvv-item-text";
      text.textContent = item.text || "（无文字）";
      el.appendChild(text);
      if (item.quote) {
        var quote = document.createElement("div");
        quote.className = "hvv-item-quote";
        quote.textContent = "原文：" + item.quote.slice(0, 80);
        el.appendChild(quote);
      }
      var metaRow = document.createElement("div");
      metaRow.className = "hvv-item-meta";
      var tag = document.createElement("span");
      tag.textContent =
        row.kind + (item.doubt ? " · 存疑" : "") +
        (item.at ? " · " + clockOf(item.at) : "");
      metaRow.appendChild(tag);
      if (item.quote || typeof item.y === "number") {
        var jump = document.createElement("button");
        jump.textContent = "定位";
        jump.addEventListener("click", function () {
          jumpToItem(item);
        });
        metaRow.appendChild(jump);
      }
      var edit = document.createElement("button");
      edit.textContent = "编辑";
      edit.addEventListener("click", function () {
        openPop("编辑" + row.kind, item.text || "", item.doubt === true, function (res) {
          if (!res) return;
          item.text = res.text;
          item.doubt = res.doubt;
          item.at = nowIso();
          renderZone();
          scheduleSave();
        });
      });
      metaRow.appendChild(edit);
      var del = document.createElement("button");
      del.textContent = "删除";
      del.addEventListener("click", function () {
        removeItem(row.kind, item.id);
        renderZone();
        scheduleSave();
      });
      metaRow.appendChild(del);
      el.appendChild(metaRow);
      list.appendChild(el);
    });
  }

  function removeItem(kind, id) {
    var arr =
      kind === "评注"
        ? state.annotations
        : kind === "标记"
          ? state.marks
          : state.notes;
    var idx = -1;
    arr.forEach(function (it, i) {
      if (it.id === id) idx = i;
    });
    if (idx >= 0) {
      // 墓碑：删除也要跨设备同步
      arr[idx] = {
        id: id,
        deleted: true,
        at: nowIso(),
      };
    }
  }

  function jumpToItem(item) {
    var target = null;
    if (item.quote) {
      target = findQuoteEl(item.quote);
    }
    if (!target && typeof item.y === "number") {
      var y = item.y;
      var best = null;
      var bestDist = Infinity;
      contentEls("p, li, h2, h3, h4").forEach(
        function (el) {
          var top = el.getBoundingClientRect().top + scrollTop();
          var d = Math.abs(top - y);
          if (d < bestDist) {
            bestDist = d;
            best = el;
          }
        },
      );
      target = best;
    }
    if (!target) {
      showStatus("原文已改动，找不到位置了");
      return;
    }
    var top = target.getBoundingClientRect().top + scrollTop() - viewportHeight() / 3;
    scrollToPos(top, true);
    target.classList.add("hvv-flash");
    window.setTimeout(function () {
      target.classList.remove("hvv-flash");
    }, 1600);
  }

  function findQuoteEl(quote) {
    if (!quote) return null;
    var walker = document.createTreeWalker(contentEl(), NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.indexOf(quote) >= 0) {
        return node.parentElement;
      }
    }
    return null;
  }

  function applyMarks() {
    $$("mark.hvv-annot").forEach(function (m) {
      m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
    });
    $$(".hvv-marked").forEach(function (m) {
      m.classList.remove("hvv-marked");
    });
    state.annotations.forEach(function (a) {
      if (!a.quote) return;
      var walker = document.createTreeWalker(contentEl(), NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || node.nodeValue.indexOf(a.quote) < 0) continue;
        try {
          var range = document.createRange();
          var idx = node.nodeValue.indexOf(a.quote);
          range.setStart(node, idx);
          range.setEnd(node, idx + a.quote.length);
          var mark = document.createElement("mark");
          mark.className = "hvv-annot";
          range.surroundContents(mark);
        } catch (e) {
          /* ignore */
        }
        break;
      }
    });
    state.marks.forEach(function (m) {
      if (typeof m.y !== "number") return;
      var best = null;
      var bestDist = Infinity;
      contentEls("p, li, h2, h3, h4").forEach(
        function (el) {
          var top = el.getBoundingClientRect().top + scrollTop();
          var d = Math.abs(top - m.y);
          if (d < bestDist) {
            bestDist = d;
            best = el;
          }
        },
      );
      if (best && bestDist < window.innerHeight * 2) {
        best.classList.add("hvv-marked");
      }
    });
  }

  // ---------------------------------------------------------------- 弹窗

  var pop = null;

  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "hvv-pop";
    pop.innerHTML =
      '<h4 data-hvv-pop-title></h4>' +
      '<textarea data-hvv-pop-input placeholder="写点什么…"></textarea>' +
      '<div class="hvv-pop-row"><label><input type="checkbox" data-hvv-pop-doubt> 标记为「存疑」（可以留空）</label></div>' +
      '<div class="hvv-pop-actions">' +
      '<button data-hvv-pop-cancel>取消</button>' +
      '<button class="hvv-ok" data-hvv-pop-ok>确定</button>' +
      '</div>';
    hostUiRoot().appendChild(pop);
    return pop;
  }

  function openPop(title, initial, initialDoubt, cb) {
    var p = ensurePop();
    $("[data-hvv-pop-title]", p).textContent = title;
    $("[data-hvv-pop-input]", p).value = initial || "";
    $("[data-hvv-pop-doubt]", p).checked = !!initialDoubt;
    p.classList.add("is-on");
    var input = $("[data-hvv-pop-input]", p);
    window.setTimeout(function () {
      input.focus();
    }, 30);

    function cleanup() {
      p.classList.remove("is-on");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
    }
    function onOk() {
      var res = {
        text: input.value.trim(),
        doubt: $("[data-hvv-pop-doubt]", p).checked,
      };
      cleanup();
      cb(res);
    }
    function onCancel() {
      cleanup();
      cb(null);
    }
    function onKey(e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onOk();
      if (e.key === "Escape") onCancel();
    }
    var okBtn = $("[data-hvv-pop-ok]", p);
    var cancelBtn = $("[data-hvv-pop-cancel]", p);
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
  }

  // ---------------------------------------------------------------- 选中批注

  var selTool = null;

  function setupSelectionTool() {
    selTool = document.createElement("div");
    selTool.className = "hvv-seltool";
    selTool.innerHTML =
      '<button data-hvv-sel="comment">💬 评注</button>' +
      '<button data-hvv-sel="doubt">❓ 存疑</button>';
    hostUiRoot().appendChild(selTool);

    document.addEventListener("mouseup", function (e) {
      // page 宿主：只在当前正文根内响应，别去动 Obsidian 自己的界面
      if (!inHostScope(e && e.target)) return;
      window.setTimeout(function () {
        var sel = window.getSelection();
        var text = sel ? sel.toString().trim() : "";
        if (!text) {
          selTool.classList.remove("is-on");
          return;
        }
        var range = sel.getRangeAt(0);
        var rect = range.getBoundingClientRect();
        selTool.style.left = Math.max(8, rect.left + rect.width / 2 - 60) + "px";
        selTool.style.top = Math.max(8, rect.top - 40) + "px";
        selTool.setAttribute("data-hvv-quote", text.slice(0, 200));
        selTool.classList.add("is-on");
      }, 10);
    });

    selTool.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-hvv-sel]");
      if (!btn) return;
      var kind = btn.getAttribute("data-hvv-sel");
      var quote = selTool.getAttribute("data-hvv-quote") || "";
      selTool.classList.remove("is-on");
      window.getSelection().removeAllRanges();
      openPop(kind === "doubt" ? "标记为存疑" : "添加评注", "", kind === "doubt", function (res) {
        if (!res) return;
        addAnnotation({
          quote: quote,
          text: res.text,
          doubt: kind === "doubt" || res.doubt,
        });
        renderZone();
        applyMarks();
        scheduleSave();
      });
    });

    document.addEventListener("mousedown", function (e) {
      if (!inHostScope(e.target)) return;
      if (!selTool.contains(e.target)) selTool.classList.remove("is-on");
    });
  }

  function addAnnotation(input) {
    var item = {
      id: uid("a"),
      text: input.text || "",
      quote: input.quote || "",
      doubt: input.doubt === true,
      at: nowIso(),
      tags: [],
      category: "",
    };
    state.annotations.push(item);
    return item;
  }

  function addMark(input) {
    var item = {
      id: uid("m"),
      text: input.text || "",
      y: Math.round(scrollTop()),
      quote: nearestQuote(),
      doubt: input.doubt === true,
      at: nowIso(),
      tags: [],
      category: "",
    };
    state.marks.push(item);
    return item;
  }

  function addNote(text) {
    var item = {
      id: uid("n"),
      text: text || "",
      at: nowIso(),
      tags: [],
      category: "",
    };
    state.notes.push(item);
    return item;
  }

  function nearestQuote() {
    var y = scrollTop();
    var best = null;
    var bestDist = Infinity;
    contentEls("p, li, h2, h3").forEach(function (el) {
      var top = el.getBoundingClientRect().top + scrollTop();
      var d = Math.abs(top - y);
      if (d < bestDist) {
        bestDist = d;
        best = el;
      }
    });
    return best ? (best.textContent || "").trim().slice(0, 80) : "";
  }

  // ---------------------------------------------------------------- 翻页键

  var pager = null;
  var flipCount = 0;

  /**
   * 翻一屏（视口 90%）。
   *
   * ★ 刻意用 behavior:"instant" 而不是 "smooth"：
   *   后续可能部署到墨水屏设备（低刷新率、刷新有残影），平滑滚动在那里会
   *   又慢又难看。翻页一律瞬时跳转。
   */
  function flipPage(dir) {
    flipCount++;
    scrollByPos(dir * viewportHeight() * 0.9);
  }

  /** 翻页键位置：top 是垂直位置比例（0.5 = 居中），right 是距右边缘像素 */
  function pagerPos() {
    var p = state.ui.pager || {};
    if (typeof p.top === "number" && typeof p.right === "number") {
      return { top: p.top, right: p.right };
    }
    // 旧版格式 { x, y }：x 距右、y 距下 → 迁移成「垂直居中 + 距右」
    return {
      top: 0.5,
      right: typeof p.x === "number" ? p.x : 20,
    };
  }

  function setupPager() {
    pager = document.createElement("div");
    pager.className = "hvv-pager";
    pager.innerHTML =
      '<button class="hvv-pager-btn" data-hvv-dir="-1" aria-label="向上翻页">▲</button>' +
      '<button class="hvv-pager-btn" data-hvv-dir="1" aria-label="向下翻页">▼</button>';
    hostUiRoot().appendChild(pager);
    applyPagerPosition();

    /**
     * ★ 关键坑：pointerdown 里的 setPointerCapture 会按 Pointer Events 规范
     *   把后续 click 事件的 target 重定向到捕获元素（pager 容器本身），
     *   于是 e.target.closest("[data-hvv-dir]") 永远为 null —— 翻页从不上线就没生效过。
     *   所以方向必须在 pointerdown 时就记下来。
     */
    var pressedDir = null;

    var dragging = false;
    var moved = false;
    var startX = 0;
    var startY = 0;
    var startRight = 20;
    var startTop = 0.5;

    pager.addEventListener("pointerdown", function (e) {
      var btn = e.target.closest("[data-hvv-dir]");
      pressedDir = btn ? Number(btn.getAttribute("data-hvv-dir")) : null;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      var pos = pagerPos();
      startRight = pos.right;
      startTop = pos.top;
      pager.classList.add("is-active");
      try {
        pager.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });

    pager.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      var right = Math.max(4, Math.min(window.innerWidth - 60, startRight - dx));
      var top = Math.max(
        0.05,
        Math.min(0.95, startTop + dy / Math.max(1, window.innerHeight)),
      );
      pager.style.right = Math.round(right) + "px";
      pager.style.top = Math.round(top * 1000) / 10 + "%";
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      pager.classList.remove("is-active");
      try {
        pager.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved) {
        // 读刚拖出来的 style，而不是旧的状态值
        var topPct = (parseFloat(pager.style.top) || 50) / 100;
        var rightPx = parseFloat(pager.style.right);
        if (!isNaN(rightPx)) {
          state.ui.pager = {
            top: Math.round(topPct * 1000) / 1000,
            right: Math.round(rightPx),
          };
          scheduleSave();
        }
      }
    }
    pager.addEventListener("pointerup", endDrag);
    pager.addEventListener("pointercancel", endDrag);

    pager.addEventListener("click", function (e) {
      if (moved) {
        // 刚刚是拖动，不是点击 → 不翻页
        moved = false;
        pressedDir = null;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      var dir = pressedDir;
      if (dir === null || dir === undefined || isNaN(dir)) {
        var btn = e.target.closest("[data-hvv-dir]");
        dir = btn ? Number(btn.getAttribute("data-hvv-dir")) : null;
      }
      pressedDir = null;
      if (dir === null || dir === undefined || isNaN(dir)) return;
      flipPage(dir);
    });
  }

  function applyPagerPosition() {
    if (!pager) return;
    var p = pagerPos();
    pager.style.right = Math.round(p.right) + "px";
    pager.style.top = Math.round(p.top * 1000) / 10 + "%";
    pager.style.transform = "translateY(-50%)";
  }

  // ---------------------------------------------------------------- 触屏分区翻页

  var touchFlip = null;

  /** 点在这些元素上时不触发分区翻页 */
  function isInteractiveTarget(el) {
    if (!el || !el.closest) return false;
    return !!el.closest(
      "a,button,input,textarea,select,label,summary,details,[contenteditable]," +
        "[data-hvv-ink],[data-hvv-dir],.hvv-pager,.hvv-ink-fab,.hvv-inkbar," +
        ".hvv-brushgrid,.hvv-overlay,.hvv-pop,.hvv-dialog,.hvv-seltool,.hvv-zone,.hvv-panel,.hvv-panel-tab",
    );
  }

  /**
   * 触屏分区翻页：点按才翻页（上半屏向上 / 下半屏向下），滑动照常滚动。
   * 画笔模式下不参与（触摸用于绘制或跟手滚动）。
   */
  function setupTouchFlip() {
    document.addEventListener(
      "touchstart",
      function (e) {
        touchFlip = null;
        if (!inHostScope(e.target)) return;
        if (ink.active) return;
        if (!e.touches || e.touches.length !== 1) return;
        var t = e.touches[0];
        touchFlip = {
          x: t.clientX,
          y: t.clientY,
          at: Date.now(),
          skip: isInteractiveTarget(e.target),
        };
      },
      { passive: true },
    );
    document.addEventListener(
      "touchend",
      function (e) {
        if (!touchFlip) return;
        var info = touchFlip;
        touchFlip = null;
        if (info.skip || ink.active) return;
        var t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        // 滑动 → 交给原生滚动
        if (Math.abs(t.clientX - info.x) > 10) return;
        if (Math.abs(t.clientY - info.y) > 10) return;
        if (Date.now() - info.at > 400) return;
        // 已经有选区 → 用户在选文字，不翻页
        try {
          var sel = window.getSelection ? window.getSelection() : null;
          if (sel && sel.toString && sel.toString().trim()) return;
        } catch (err) {
          /* ignore */
        }
        flipPage(t.clientY < window.innerHeight / 2 ? -1 : 1);
      },
      { passive: true },
    );
  }

  // ---------------------------------------------------------------- 图片

  var overlay = null;
  var overlayImg = null;
  var imageState = "thumb";

  function setupImages() {
    overlay = document.createElement("div");
    overlay.className = "hvv-overlay";
    overlay.innerHTML =
      '<span class="hvv-overlay-hint">双击：等宽 → 全屏 ｜ ESC / 点背景关闭</span>';
    overlayImg = document.createElement("img");
    overlay.appendChild(overlayImg);
    hostUiRoot().appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeOverlay();
    });

    overlayImg.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      advanceImage();
    });

    var lastTap = 0;
    overlayImg.addEventListener("touchend", function () {
      var now = Date.now();
      if (now - lastTap < 300) {
        advanceImage();
        lastTap = 0;
      } else {
        lastTap = now;
      }
    });

    contentEls("img").forEach(function (img) {
      img.classList.add("hvv-img");
      img.setAttribute("data-hvv-img", "1");
      img.addEventListener("dblclick", function (e) {
        e.preventDefault();
        openOverlay(img);
      });
      var t = 0;
      img.addEventListener("touchend", function () {
        var now = Date.now();
        if (now - t < 300) {
          openOverlay(img);
          t = 0;
        } else {
          t = now;
        }
      });
    });
  }

  function openOverlay(img) {
    overlayImg.src = img.src;
    overlayImg.alt = img.alt || "";
    overlay.classList.add("is-on");
    imageState = "fit";
    overlay.classList.add("is-fit");
    overlay.classList.remove("is-full");
  }

  function advanceImage() {
    if (imageState === "fit") {
      imageState = "full";
      overlay.classList.add("is-full");
      overlay.classList.remove("is-fit");
      if (overlay.requestFullscreen) {
        overlay.requestFullscreen().catch(function () {});
      }
    } else if (imageState === "full") {
      imageState = "fit";
      overlay.classList.remove("is-full");
      overlay.classList.add("is-fit");
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    } else {
      imageState = "fit";
      overlay.classList.add("is-fit");
    }
  }

  function closeOverlay() {
    overlay.classList.remove("is-on", "is-full", "is-fit");
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
    imageState = "thumb";
  }

  document.addEventListener("keydown", function (e) {
    // page 宿主：只在焦点落在当前正文根里时才接管键盘
    if (!hostHasFocus()) return;
    if (e.key === "Escape" && overlay && overlay.classList.contains("is-on")) {
      closeOverlay();
      return;
    }
    if (e.key === "Escape" && ink.active) {
      inkExit();
      return;
    }
    // ESC 关掉笔记与标注面板
    if (e.key === "Escape") {
      var z = $("#html-interaction-zone");
      if (z && z.classList.contains("is-on")) closePanel();
    }
  });

  // ---------------------------------------------------------------- 判分

  function updateJudges() {
    $$(".hvv-q-judge, .hvv-q-doubt").forEach(function (el) {
      el.parentNode.removeChild(el);
    });
    var questions = Array.isArray(meta.questions) ? meta.questions : [];
    if (!questions.length) return;
    var map = {};
    questions.forEach(function (q) {
      if (isPlainObject(q) && typeof q.id === "string") map[q.id] = q;
    });
    questionBlocks().forEach(function (block) {
      var qid = block.getAttribute("data-qid");
      var q = map[qid];
      if (!q) return;
      var std = q.answer;
      var value = readValue(block, qid);
      if (std === undefined || value === undefined) return;
      var norm = function (v) {
        return (Array.isArray(v) ? v : [v])
          .map(function (x) {
            return String(x).trim();
          })
          .sort()
          .join(",");
      };
      var ok = norm(value) === norm(std);
      var badge = document.createElement("span");
      badge.className = "hvv-q-judge " + (ok ? "is-ok" : "is-no");
      badge.textContent = ok ? "✓ 正确" : "✗ 错误（正确：" + std + "）";
      var titleEl = $(".q-title", block) || $("p", block) || block.firstElementChild;
      if (titleEl && titleEl.parentNode === block) {
        block.insertBefore(badge, titleEl.nextSibling);
      } else {
        block.appendChild(badge);
      }
    });
  }

  // ---------------------------------------------------------------- 手写标注层

  var INK_NS = "http://www.w3.org/2000/svg";
  var INK_COLORS = [
    { key: "ink", label: "墨黑", css: "#1f2328" },
    { key: "red", label: "红", css: "#e0453a" },
    { key: "yellow", label: "荧光黄", css: "rgba(255, 206, 60, .55)" },
    { key: "blue", label: "蓝", css: "#2f6fd0" },
  ];
  var INK_WIDTHS = [2, 4, 8];
  var ANCHOR_LEN = 40;
  var ANCHOR_SELECTOR =
    "p,li,h1,h2,h3,h4,h5,h6,td,th,figure,figcaption,blockquote,pre,dt,dd,caption";

  /**
   * 手写层状态。
   * - draft：临时笔迹，只在内存里，永远不落盘
   * - state.strokes：已保存笔迹，进文件，跨设备同步
   */
  var ink = {
    active: false,
    draft: [],
    color: "ink",
    width: 4,
    eraser: false,
    forcePen: false,
    scrollMode: false,
    penSeen: false,
    zoom: 1,
    drawing: null,
    scrollState: null,
  };

  var inkSvg = null;
  var inkSpacer = null;
  var inkFab = null;
  var inkBar = null;
  var inkGrid = null;
  var inkZoomTag = null;
  var inkDialog = null;

  // ---- 路径数学（纯函数，可单测） ----

  function inkNum(n) {
    return String(Math.round((Number(n) || 0) * 100) / 100);
  }

  /** 点集 → SVG 路径。首点绝对，其后全部相对（平移时只需改首点）。 */
  function inkPointsToPath(pts) {
    if (!pts || !pts.length) return "";
    var out = "M" + inkNum(pts[0].x) + "," + inkNum(pts[0].y);
    for (var i = 1; i < pts.length; i++) {
      out +=
        " l" +
        inkNum(pts[i].x - pts[i - 1].x) +
        "," +
        inkNum(pts[i].y - pts[i - 1].y);
    }
    return out;
  }

  /** SVG 路径 → 点集（只认本层自己产出的 M/l 格式） */
  function inkPathToPoints(d) {
    var out = [];
    if (!d) return out;
    var nums = String(d).match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return out;
    var x = parseFloat(nums[0]);
    var y = parseFloat(nums[1]);
    out.push({ x: x, y: y });
    for (var i = 2; i + 1 < nums.length; i += 2) {
      x += parseFloat(nums[i]);
      y += parseFloat(nums[i + 1]);
      out.push({ x: x, y: y });
    }
    return out;
  }

  /** 平移路径：相对路径只需改首点 */
  function inkTranslatePath(d, dx, dy) {
    if (!d) return d;
    var m = /^M(-?[\d.]+),(-?[\d.]+)/.exec(d);
    if (!m) return d;
    return (
      "M" +
      inkNum(parseFloat(m[1]) + dx) +
      "," +
      inkNum(parseFloat(m[2]) + dy) +
      d.slice(m[0].length)
    );
  }

  function inkDist(ax, ay, bx, by) {
    var dx = ax - bx;
    var dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function inkDistToSeg(p, a, b) {
    var vx = b.x - a.x;
    var vy = b.y - a.y;
    var len2 = vx * vx + vy * vy;
    if (len2 === 0) return inkDist(p.x, p.y, a.x, a.y);
    var t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return inkDist(p.x, p.y, a.x + t * vx, a.y + t * vy);
  }

  // ---- 坐标换算 ----

  function inkRoot() {
    return contentRoot();
  }

  /**
   * 内容区（content）坐标系原点的视口位置。
   * 坐标系原点 = 内容区 padding box 左上角，与 SVG 的用户单位 1:1。
   * 缩放时用 rect 反算，因此任何缩放下换算都成立。
   */
  function inkContentOrigin() {
    var root = inkRoot();
    var r = root.getBoundingClientRect();
    var cs = window.getComputedStyle(root);
    var bl = parseFloat(cs.borderLeftWidth) || 0;
    var bt = parseFloat(cs.borderTopWidth) || 0;
    var k = ink.zoom || 1;
    return { x: r.left + k * bl, y: r.top + k * bt, k: k };
  }

  function inkToContent(clientX, clientY) {
    var o = inkContentOrigin();
    return { x: (clientX - o.x) / o.k, y: (clientY - o.y) / o.k };
  }

  function inkBlockBox(el) {
    var o = inkContentOrigin();
    var r = el.getBoundingClientRect();
    return { left: (r.left - o.x) / o.k, top: (r.top - o.y) / o.k };
  }

  function inkDepth(el) {
    var d = 0;
    var p = el;
    var root = inkRoot();
    while (p && p !== root) {
      d++;
      p = p.parentElement;
    }
    return d;
  }

  // ---- 锚点 ----

  /** 找到包含该点的最内层块级元素；找不到则取最近的 */
  function inkNearestBlock(x, y) {
    var o = inkContentOrigin();
    var k = o.k;
    var root = inkRoot();
    var blocks = $$(ANCHOR_SELECTOR, root);
    var inside = [];
    var nearest = null;
    var nearestDist = Infinity;
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      var r = el.getBoundingClientRect();
      var l = (r.left - o.x) / k;
      var t = (r.top - o.y) / k;
      var w = r.width / k;
      var h = r.height / k;
      if (
        x >= l - 2 &&
        x <= l + w + 2 &&
        y >= t - 2 &&
        y <= t + h + 2
      ) {
        inside.push({ el: el, l: l, t: t, w: w, h: h });
      } else {
        var dy = y < t ? t - y : y > t + h ? y - (t + h) : 0;
        var dx = x < l ? l - x : x > l + w ? x - (l + w) : 0;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = { el: el, l: l, t: t, w: w, h: h };
        }
      }
    }
    if (!inside.length) return nearest;
    // 取最内层（DOM 最深）的那个；同深度取面积小的
    inside.sort(function (a, b) {
      var da = inkDepth(a.el);
      var db = inkDepth(b.el);
      if (da !== db) return db - da;
      return a.w * a.h - b.w * b.h;
    });
    return inside[0];
  }

  function inkAnchorFor(x, y) {
    var b = inkNearestBlock(x, y);
    if (!b) return null;
    var text = (b.el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, ANCHOR_LEN);
    return {
      text: text,
      dx: Math.round((x - b.l) * 100) / 100,
      dy: Math.round((y - b.t) * 100) / 100,
    };
  }

  function inkFindBlockByText(text) {
    if (!text) return null;
    var norm = String(text).replace(/\s+/g, " ").trim();
    if (!norm) return null;
    var blocks = $$(ANCHOR_SELECTOR, inkRoot());
    var i;
    for (i = 0; i < blocks.length; i++) {
      var t = (blocks[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t === norm) return blocks[i];
    }
    for (i = 0; i < blocks.length; i++) {
      var t2 = (blocks[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t2.indexOf(norm) === 0) return blocks[i];
    }
    for (i = 0; i < blocks.length; i++) {
      var t3 = (blocks[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t3.indexOf(norm) >= 0) return blocks[i];
    }
    return null;
  }

  /**
   * 重排校正：把笔迹按「所属段落的新位置」整体平移。
   * 偏移量只存在内存里（dx/dy），不写进文件，避免多设备互相覆盖坐标。
   */
  function inkApplyReflow() {
    var changed = 0;
    state.strokes.forEach(function (s) {
      if (s.deleted) return;
      if (!s.anchor || !s.anchor.text) return;
      var el = inkFindBlockByText(s.anchor.text);
      if (!el) return;
      var box = inkBlockBox(el);
      var pts = inkPathToPoints(s.d);
      if (!pts.length) return;
      var dx = box.left + (s.anchor.dx || 0) - pts[0].x;
      var dy = box.top + (s.anchor.dy || 0) - pts[0].y;
      s.dx = Math.round(dx * 100) / 100;
      s.dy = Math.round(dy * 100) / 100;
      changed++;
    });
    return changed;
  }

  // ---- 图层 ----

  function ensureInkLayer() {
    if (inkSvg) return inkSvg;
    var root = inkRoot();
    root.style.position = "relative";
    inkSvg = document.createElementNS(INK_NS, "svg");
    inkSvg.setAttribute("class", "hvv-ink");
    inkSvg.setAttribute("aria-hidden", "true");
    root.appendChild(inkSvg);
    inkSpacer = document.createElement("div");
    inkSpacer.className = "hvv-ink-zoomspace";
    if (root.parentNode) {
      root.parentNode.insertBefore(inkSpacer, root.nextSibling);
    } else {
      hostUiRoot().appendChild(inkSpacer);
    }
    return inkSvg;
  }

  function inkColorCss(key) {
    for (var i = 0; i < INK_COLORS.length; i++) {
      if (INK_COLORS[i].key === key) {
        return key === "ink"
          ? "var(--hvv-ink, #1f2328)"
          : INK_COLORS[i].css;
      }
    }
    return "var(--hvv-ink, #1f2328)";
  }

  function inkOpacityOf(color) {
    return color === "yellow" ? 0.45 : 1;
  }

  function inkEffectivePath(s) {
    var d = s.d || "";
    if (s.dx || s.dy) d = inkTranslatePath(d, s.dx || 0, s.dy || 0);
    return d;
  }

  function inkMakePathEl(s, cls) {
    var p = document.createElementNS(INK_NS, "path");
    p.setAttribute("class", cls);
    p.setAttribute("d", inkEffectivePath(s));
    p.setAttribute("stroke", inkColorCss(s.color));
    p.setAttribute("stroke-width", String(s.width || 4));
    p.setAttribute("opacity", String(s.opacity == null ? inkOpacityOf(s.color) : s.opacity));
    p.setAttribute("data-hvv-stroke", s.id || "");
    return p;
  }

  function inkRender() {
    if (!inkSvg) return;
    while (inkSvg.firstChild) inkSvg.removeChild(inkSvg.firstChild);
    state.strokes.forEach(function (s) {
      if (s.deleted) return;
      inkSvg.appendChild(inkMakePathEl(s, "hvv-saved"));
    });
    ink.draft.forEach(function (s) {
      inkSvg.appendChild(inkMakePathEl(s, "hvv-draft"));
    });
  }

  // ---- 工具条 / 悬浮按钮 ----

  function inkBuildBar() {
    if (inkBar) return inkBar;
    var bar = document.createElement("div");
    bar.className = "hvv-inkbar";
    bar.setAttribute("data-hvv-ink", "bar");
    bar.innerHTML =
      '<span class="hvv-grip" data-hvv-ink="grip" title="拖动可吸附到四边">⠿</span>' +
      '<button data-hvv-ink="brush" title="笔刷（颜色 / 粗细）">🖌</button>' +
      '<button data-hvv-ink="eraser" title="橡皮：点选删除一笔">🩹</button>' +
      '<button data-hvv-ink="clear" title="单击清临时涂鸦，双击清全部">🧹</button>' +
      '<button data-hvv-ink="save" title="保存涂鸦到文件">💾</button>' +
      '<button data-hvv-ink="pen" title="强制笔模式：手指只滚动，笔负责画">🎯</button>' +
      '<button data-hvv-ink="scroll" title="临时放开页面滚动">☝</button>' +
      '<button data-hvv-ink="exit" title="退出画笔模式">✕</button>';
    hostUiRoot().appendChild(bar);
    inkBar = bar;
    return bar;
  }

  function inkBuildGrid() {
    if (inkGrid) return inkGrid;
    var g = document.createElement("div");
    g.className = "hvv-brushgrid";
    INK_COLORS.forEach(function (c) {
      INK_WIDTHS.forEach(function (w) {
        var b = document.createElement("button");
        b.className = "hvv-swatch";
        b.setAttribute("data-hvv-color", c.key);
        b.setAttribute("data-hvv-w", String(w));
        b.style.background = c.key === "ink" ? "var(--hvv-ink, #1f2328)" : c.css;
        b.style.borderWidth = Math.max(1, Math.round(w / 2)) + "px";
        b.title = c.label + " · " + w + "px";
        g.appendChild(b);
      });
    });
    hostUiRoot().appendChild(g);
    inkGrid = g;
    return g;
  }

  function inkBuildFab() {
    if (inkFab) return inkFab;
    var b = document.createElement("button");
    b.className = "hvv-ink-fab";
    b.setAttribute("data-hvv-ink", "fab");
    b.textContent = "✏️";
    b.title = "手写标注（点按进入 / 退出画笔模式）";
    hostUiRoot().appendChild(b);
    inkFab = b;
    return b;
  }

  var haltBtn = null;

  /**
   * 「静止的悬浮开关」。
   *
   * 常驻右下角、在触笔按钮正上方，不随页面滚动。
   * 默认是「开着」的（按钮显示暂停图标，点一下会关停）；
   * 关停之后按钮依然可点，否则就再也开不回来了。
   */
  function ensureHaltButton() {
    if (haltBtn) return haltBtn;
    var b = document.createElement("button");
    b.className = "hvv-halt";
    b.setAttribute("data-hvv-halt", "1");
    b.textContent = "⏸";
    b.title = "临时关停插件（关掉后可以正常选中和编辑正文）";
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var now = setPaused(!HOST.paused);
      haltBtn.classList.toggle("is-paused", now);
      haltBtn.textContent = now ? "▶" : "⏸";
      haltBtn.title = now ? "恢复插件" : "临时关停插件（关掉后可以正常选中和编辑正文）";
      if (typeof HOST.onToggle === "function") {
        try {
          HOST.onToggle(now);
        } catch (err) {
          /* ignore */
        }
      }
    });
    hostUiRoot().appendChild(b);
    haltBtn = b;
    return b;
  }

  function inkBuildZoomTag() {
    if (inkZoomTag) return inkZoomTag;
    var t = document.createElement("div");
    t.className = "hvv-zoomtag";
    t.innerHTML =
      '<span data-hvv-zoom-label>⤢ 200%</span>' +
      '<button data-hvv-ink="zoom-reset">还原</button>';
    hostUiRoot().appendChild(t);
    inkZoomTag = t;
    return t;
  }

  function inkUpdateZoomTag() {
    if (!inkZoomTag) return;
    var on = ink.zoom !== 1;
    inkZoomTag.classList.toggle("is-on", on);
    var label = $("[data-hvv-zoom-label]", inkZoomTag);
    if (label) label.textContent = "⤢ " + Math.round(ink.zoom * 100) + "%";
  }

  function inkApplyBarEdge(edge) {
    if (!inkBar) return;
    var e = edge || "bottom";
    inkBar.classList.toggle("is-v", e === "left" || e === "right");
    inkBar.style.left = "";
    inkBar.style.top = "";
    inkBar.style.right = "";
    inkBar.style.bottom = "";
    inkBar.style.transform = "";
    if (e === "top") {
      inkBar.style.left = "50%";
      inkBar.style.top = "10px";
      inkBar.style.transform = "translateX(-50%)";
    } else if (e === "bottom") {
      inkBar.style.left = "10px";
      inkBar.style.right = "74px";
      inkBar.style.bottom = "10px";
    } else if (e === "left") {
      inkBar.style.left = "8px";
      inkBar.style.top = "50%";
      inkBar.style.transform = "translateY(-50%)";
    } else {
      inkBar.style.right = "8px";
      inkBar.style.top = "50%";
      inkBar.style.transform = "translateY(-50%)";
    }
  }

  function inkSnapBar() {
    if (!inkBar) return;
    var r = inkBar.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var dTop = r.top;
    var dBottom = vh - r.bottom;
    var dLeft = r.left;
    var dRight = vw - r.right;
    var min = Math.min(dTop, dBottom, dLeft, dRight);
    var edge = "bottom";
    if (min === dTop) edge = "top";
    else if (min === dBottom) edge = "bottom";
    else if (min === dLeft) edge = "left";
    else edge = "right";
    state.ui.inkbar = { edge: edge };
    inkApplyBarEdge(edge);
    scheduleSave();
  }

  function inkUpdateBarState() {
    if (!inkBar) return;
    var brush = $('[data-hvv-ink="brush"]', inkBar);
    if (brush) {
      brush.style.color = inkColorCss(ink.color);
      brush.style.fontWeight = ink.width >= 8 ? "900" : ink.width >= 4 ? "700" : "400";
      brush.title = "笔刷：" + inkWidthLabel(ink.width);
    }
    $('[data-hvv-ink="eraser"]', inkBar).classList.toggle("is-on", ink.eraser);
    $('[data-hvv-ink="pen"]', inkBar).classList.toggle("is-on", ink.forcePen);
    $('[data-hvv-ink="scroll"]', inkBar).classList.toggle("is-on", ink.scrollMode);
    if (inkGrid) {
      $$("[data-hvv-color]", inkGrid).forEach(function (b) {
        b.classList.toggle(
          "is-on",
          b.getAttribute("data-hvv-color") === ink.color &&
            Number(b.getAttribute("data-hvv-w")) === ink.width,
        );
      });
    }
  }

  function inkWidthLabel(w) {
    return w >= 8 ? "粗" : w >= 4 ? "中" : "细";
  }

  // ---- 模式切换 ----

  function inkSetActive(on) {
    if (ink.active === on) return;
    ink.active = on;
    hostUiRoot().classList.toggle("is-ink", on);
    if (inkFab) {
      inkFab.textContent = on ? "✕" : "✏️";
      inkFab.classList.toggle("is-on", on);
      inkFab.title = on ? "退出画笔模式" : "手写标注（点按进入画笔模式）";
    }
    if (inkBar) inkBar.classList.toggle("is-on", on);
    if (inkGrid) inkGrid.classList.remove("is-on");
    if (on) {
      ensureInkLayer();
      inkRender();
      showStatus("画笔模式：直接在页面上写。ESC 或 ✕ 退出。");
    } else {
      inkZoomReset(true);
      ink.draft = [];
      inkRender();
    }
    inkReport();
  }

  function inkExit() {
    if (!ink.draft.length) {
      inkSetActive(false);
      saveNow();
      return;
    }
    openInkDialog(
      "有 " + ink.draft.length + " 笔未保存的涂鸦",
      "临时涂鸦只存在内存里，关闭页面就没了。要保存进文件吗？",
      [
        { label: "取消", value: null },
        { label: "丢弃", value: "discard" },
        { label: "保存", value: "save", cls: "hvv-ok" },
      ],
      function (choice) {
        if (choice === null) return;
        if (choice === "save") {
          inkSave();
        } else {
          ink.draft = [];
          inkRender();
        }
        inkSetActive(false);
        saveNow();
      },
    );
  }

  // ---- 通用对话框 ----

  function ensureDialog() {
    if (inkDialog) return inkDialog;
    var d = document.createElement("div");
    d.className = "hvv-dialog";
    d.innerHTML =
      '<h4 data-hvv-dlg-title></h4>' +
      '<div data-hvv-dlg-msg class="hvv-dlg-msg"></div>' +
      '<div class="hvv-dlg-actions" data-hvv-dlg-actions></div>';
    hostUiRoot().appendChild(d);
    inkDialog = d;
    return d;
  }

  function openInkDialog(title, msg, actions, cb) {
    var d = ensureDialog();
    $("[data-hvv-dlg-title]", d).textContent = title;
    $("[data-hvv-dlg-msg]", d).textContent = msg || "";
    var box = $("[data-hvv-dlg-actions]", d);
    box.innerHTML = "";
    d.classList.add("is-on");
    actions.forEach(function (a) {
      var b = document.createElement("button");
      b.textContent = a.label;
      if (a.cls) b.className = a.cls;
      b.addEventListener("click", function () {
        d.classList.remove("is-on");
        cb(a.value);
      });
      box.appendChild(b);
    });
  }

  // ---- 绘制 ----

  function inkPointerKind(e) {
    var t = e && e.pointerType;
    if (t === "pen") return "pen";
    if (t === "touch") return "touch";
    return "mouse";
  }

  /** 该类型的指针此刻应当「滚动」而不是「画」 */
  function inkShouldScroll(kind) {
    if (ink.scrollMode) return true;
    if (kind === "mouse" || kind === "pen") return false;
    // 触摸：识别到笔（或强制笔模式）→ 手指负责滚动；否则手指负责画
    return ink.forcePen || ink.penSeen;
  }

  function inkOnPointerDown(e) {
    if (!ink.active) return;
    var kind = inkPointerKind(e);
    if (kind === "pen") ink.penSeen = true;
    if (ink.eraser) {
      inkEraseAt(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (inkShouldScroll(kind)) {
      ink.scrollState = { pointerId: e.pointerId, lastY: e.clientY };
      e.preventDefault();
      return;
    }
    e.preventDefault();
    var p = inkToContent(e.clientX, e.clientY);
    var stroke = {
      id: uid("s"),
      d: "",
      color: ink.color,
      width: ink.width,
      opacity: inkOpacityOf(ink.color),
      pts: [p],
      createdAt: Date.now(),
      at: nowIso(),
      saved: false,
    };
    var el = inkMakePathEl(stroke, "hvv-draft");
    ensureInkLayer().appendChild(el);
    ink.drawing = { stroke: stroke, el: el, pointerId: e.pointerId };
    try {
      inkSvg.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  }

  function inkOnPointerMove(e) {
    if (!ink.active) return;
    if (ink.scrollState) {
      if (ink.scrollState.pointerId !== e.pointerId) return;
      var dy = ink.scrollState.lastY - e.clientY;
      ink.scrollState.lastY = e.clientY;
      if (dy) scrollByPos(dy);
      e.preventDefault();
      return;
    }
    if (!ink.drawing || ink.drawing.pointerId !== e.pointerId) return;
    e.preventDefault();
    var list = null;
    try {
      if (typeof e.getCoalescedEvents === "function") {
        var co = e.getCoalescedEvents();
        if (co && co.length) list = co;
      }
    } catch (err) {
      /* ignore */
    }
    if (!list) list = [e];
    var stroke = ink.drawing.stroke;
    for (var i = 0; i < list.length; i++) {
      var p = inkToContent(list[i].clientX, list[i].clientY);
      var last = stroke.pts[stroke.pts.length - 1];
      if (last && Math.abs(last.x - p.x) < 0.6 && Math.abs(last.y - p.y) < 0.6) continue;
      stroke.pts.push(p);
    }
    stroke.d = inkPointsToPath(stroke.pts);
    ink.drawing.el.setAttribute("d", stroke.d);
  }

  function inkOnPointerUp(e) {
    if (ink.scrollState) {
      if (ink.scrollState.pointerId === e.pointerId) ink.scrollState = null;
      return;
    }
    if (!ink.drawing || ink.drawing.pointerId !== e.pointerId) return;
    var stroke = ink.drawing.stroke;
    ink.drawing = null;
    try {
      inkSvg.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    if (stroke.pts.length < 2) {
      // 单击不落笔（避免和双击放大打架）
      inkRender();
      return;
    }
    stroke.d = inkPointsToPath(stroke.pts);
    ink.draft.push(stroke);
    inkRender();
    inkReport();
  }

  /** 撤销最近 ms 毫秒内落下的笔（双击误触保护） */
  function inkUndoRecent(ms) {
    var now = Date.now();
    var removed = 0;
    ink.draft = ink.draft.filter(function (s) {
      if (now - (s.createdAt || 0) < ms) {
        removed++;
        return false;
      }
      return true;
    });
    if (removed) inkRender();
    return removed;
  }

  // ---- 橡皮 ----

  function inkStrokePoints(s) {
    if (s.pts && s.pts.length) return s.pts;
    return inkPathToPoints(s.d);
  }

  function inkHitStroke(s, p) {
    var pts = inkStrokePoints(s);
    if (!pts.length) return false;
    var hit = Math.max(12, (s.width || 4) + 8) / 2;
    if (pts.length === 1) return inkDist(p.x, p.y, pts[0].x, pts[0].y) <= hit;
    for (var i = 1; i < pts.length; i++) {
      if (inkDistToSeg(p, pts[i - 1], pts[i]) <= hit) return true;
    }
    return false;
  }

  function inkEraseAt(clientX, clientY) {
    var p = inkToContent(clientX, clientY);
    var i;
    for (i = ink.draft.length - 1; i >= 0; i--) {
      if (inkHitStroke(ink.draft[i], p)) {
        ink.draft.splice(i, 1);
        inkRender();
        inkReport();
        return;
      }
    }
    for (i = state.strokes.length - 1; i >= 0; i--) {
      var s = state.strokes[i];
      if (s.deleted) continue;
      if (inkHitStroke(s, p)) {
        state.strokes[i] = { id: s.id, deleted: true, at: nowIso() };
        inkRender();
        saveNow();
        showStatus("已擦除 1 笔已保存涂鸦（会同步到其他设备）");
        inkReport();
        return;
      }
    }
    showStatus("这里没有笔迹");
  }

  // ---- 保存 / 清屏 ----

  /** 写盘用的条目（剔除仅运行时的 dx/dy 偏移） */
  function inkStrokeToPersist(s) {
    if (s.deleted) return { id: s.id, deleted: true, at: s.at };
    return {
      id: s.id,
      d: s.d,
      color: s.color,
      width: s.width,
      opacity: s.opacity,
      anchor: s.anchor || null,
      at: s.at,
      saved: true,
    };
  }

  function inkSave() {
    if (!ink.draft.length) {
      showStatus("没有未保存的涂鸦");
      return;
    }
    var now = nowIso();
    var n = ink.draft.length;
    ink.draft.forEach(function (d) {
      var anchor = null;
      if (d.pts && d.pts.length) anchor = inkAnchorFor(d.pts[0].x, d.pts[0].y);
      state.strokes.push({
        id: d.id,
        d: d.d,
        color: d.color,
        width: d.width,
        opacity: d.opacity,
        anchor: anchor,
        at: now,
        saved: true,
      });
    });
    ink.draft = [];
    inkRender();
    renderZone();
    saveNow();
    showStatus("已保存 " + n + " 笔涂鸦");
    inkReport();
  }

  function inkClearDraft() {
    if (!ink.draft.length) {
      showStatus("没有未保存的涂鸦");
      return;
    }
    ink.draft = [];
    inkRender();
    showStatus("已清除临时涂鸦（已保存的不受影响）");
    inkReport();
  }

  function inkClearAll() {
    var alive = state.strokes.filter(function (s) {
      return !s.deleted;
    });
    if (!alive.length && !ink.draft.length) {
      showStatus("没有可清除的涂鸦");
      return;
    }
    openInkDialog(
      "清空全部涂鸦？",
      "将删除 " +
        alive.length +
        " 笔已保存涂鸦（会同步到其他设备），临时草稿也会一并清掉。",
      [
        { label: "取消", value: null },
        { label: "确认清空", value: "yes", cls: "hvv-ok" },
      ],
      function (choice) {
        if (choice !== "yes") return;
        var now = nowIso();
        state.strokes = state.strokes.map(function (s) {
          if (s.deleted) return s;
          return { id: s.id, deleted: true, at: now };
        });
        ink.draft = [];
        inkRender();
        renderZone();
        saveNow();
        showStatus("已清空全部涂鸦");
        inkReport();
      },
    );
  }

  // ---- 缩放 ----

  function inkZoomIn(clientX, clientY) {
    if (ink.zoom !== 1) return;
    var root = inkRoot();
    var o = inkContentOrigin();
    var ax = (clientX - o.x) / o.k;
    var ay = (clientY - o.y) / o.k;
    var k = 2;
    var tx = ax * (1 - k);
    var ty = ay * (1 - k);
    root.style.transformOrigin = "0 0";
    root.style.transform =
      "translate(" + inkNum(tx) + "px," + inkNum(ty) + "px) scale(" + k + ")";
    ink.zoom = k;
    inkZoomSpace();
    inkUpdateZoomTag();
    inkRender();
    inkReport();
  }

  function inkZoomReset(silent) {
    if (ink.zoom === 1) return;
    var root = inkRoot();
    root.style.transform = "";
    root.style.transformOrigin = "";
    ink.zoom = 1;
    inkZoomSpace();
    inkUpdateZoomTag();
    inkRender();
    if (!silent) inkReport();
  }

  function inkZoomSpace() {
    if (!inkSpacer) return;
    var root = inkRoot();
    var k = ink.zoom || 1;
    var h = root.getBoundingClientRect().height / k;
    inkSpacer.style.height = Math.max(0, Math.round(h * (k - 1))) + "px";
  }

  // ---- 双击 ----

  /** 取 SVG 下面真正的元素（画布挡住时用） */
  function inkElementAt(clientX, clientY) {
    if (!inkSvg) return null;
    inkSvg.style.pointerEvents = "none";
    var el = null;
    try {
      el = document.elementFromPoint(clientX, clientY);
    } catch (err) {
      el = null;
    }
    inkSvg.style.pointerEvents = "";
    return el;
  }

  function inkOnDblClick(e) {
    if (!ink.active) return;
    if (overlay && overlay.classList.contains("is-on")) return;
    e.preventDefault();
    inkUndoRecent(400);
    var el = inkElementAt(e.clientX, e.clientY);
    if (el && el.tagName === "IMG") {
      openOverlay(el);
      return;
    }
    if (ink.zoom !== 1) {
      inkZoomReset();
    } else {
      inkZoomIn(e.clientX, e.clientY);
    }
  }

  // ---- 状态上报 ----

  function inkState() {
    var alive = 0;
    state.strokes.forEach(function (s) {
      if (!s.deleted) alive++;
    });
    return {
      active: ink.active,
      zoom: ink.zoom,
      draft: ink.draft.length,
      saved: alive,
      total: state.strokes.length,
      color: ink.color,
      width: ink.width,
      eraser: ink.eraser,
      forcePen: ink.forcePen,
      scrollMode: ink.scrollMode,
      penSeen: ink.penSeen,
      edge: (state.ui.inkbar && state.ui.inkbar.edge) || "bottom",
    };
  }

  function inkReport() {
    post(MSG.INK, inkState());
  }

  // ---- 初始化 ----

  function setupInk() {
    ensureInkLayer();
    inkBuildFab();
    inkBuildBar();
    inkBuildGrid();
    inkBuildZoomTag();

    inkApplyBarEdge((state.ui.inkbar && state.ui.inkbar.edge) || "bottom");
    inkUpdateBarState();

    // 画布上的指针事件
    inkSvg.addEventListener("pointerdown", inkOnPointerDown);
    inkSvg.addEventListener("pointermove", inkOnPointerMove);
    inkSvg.addEventListener("pointerup", inkOnPointerUp);
    inkSvg.addEventListener("pointercancel", inkOnPointerUp);

    // 双击：画笔模式下不落笔，改为放大
    document.addEventListener("dblclick", function (e) {
      if (!inHostScope(e.target)) return;
      inkOnDblClick(e);
    });

    // 画笔模式锁滚动；「☝ 滚动」可临时放开
    document.addEventListener(
      "touchmove",
      function (e) {
        if (!inHostScope(e.target)) return;
        if (ink.active && !ink.scrollMode) e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener(
      "wheel",
      function (e) {
        if (!inHostScope(e.target)) return;
        if (ink.active && !ink.scrollMode) e.preventDefault();
      },
      { passive: false },
    );

    // 悬浮按钮
    inkFab.addEventListener("click", function () {
      if (ink.active) inkExit();
      else inkSetActive(true);
    });

    // 工具条
    inkBar.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-hvv-ink]");
      if (!btn) return;
      var act = btn.getAttribute("data-hvv-ink");
      if (act === "brush") {
        var g = inkBuildGrid();
        var r = btn.getBoundingClientRect();
        g.style.left = Math.max(8, Math.min(window.innerWidth - 140, r.left - 40)) + "px";
        g.style.top = Math.max(8, r.bottom + 8) + "px";
        g.classList.toggle("is-on");
      } else if (act === "eraser") {
        ink.eraser = !ink.eraser;
        inkUpdateBarState();
        showStatus(ink.eraser ? "橡皮：点一下要删的笔迹" : "已退出橡皮");
      } else if (act === "clear") {
        inkClearDraft();
      } else if (act === "save") {
        inkSave();
      } else if (act === "pen") {
        ink.forcePen = !ink.forcePen;
        inkUpdateBarState();
        showStatus(ink.forcePen ? "强制笔模式：手指只滚动" : "已关闭强制笔模式");
      } else if (act === "scroll") {
        ink.scrollMode = !ink.scrollMode;
        inkUpdateBarState();
        showStatus(ink.scrollMode ? "滚动已放开" : "滚动已锁定");
      } else if (act === "exit") {
        inkExit();
      } else if (act === "zoom-reset") {
        inkZoomReset();
      }
    });

    // 清屏：双击才清全部
    var clearBtn = $('[data-hvv-ink="clear"]', inkBar);
    var clearTimer = null;
    clearBtn.addEventListener("dblclick", function (e) {
      e.preventDefault();
      if (clearTimer) window.clearTimeout(clearTimer);
      clearTimer = null;
      inkClearAll();
    });
    clearBtn.addEventListener("click", function () {
      if (clearTimer) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(function () {
        clearTimer = null;
      }, 400);
    });

    // 笔刷九宫格
    inkGrid.addEventListener("click", function (e) {
      var b = e.target.closest("[data-hvv-color]");
      if (!b) return;
      ink.color = b.getAttribute("data-hvv-color");
      ink.width = Number(b.getAttribute("data-hvv-w")) || 4;
      ink.eraser = false;
      inkGrid.classList.remove("is-on");
      inkUpdateBarState();
    });
    document.addEventListener("pointerdown", function (e) {
      if (!inHostScope(e.target)) return;
      if (inkGrid && !inkGrid.contains(e.target)) inkGrid.classList.remove("is-on");
    });

    // 工具条拖动 + 吸附
    var grip = $('[data-hvv-ink="grip"]', inkBar);
    var dragging = false;
    var moved = false;
    var startX = 0;
    var startY = 0;
    var startRect = null;
    grip.addEventListener("pointerdown", function (e) {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      startRect = inkBar.getBoundingClientRect();
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      e.preventDefault();
    });
    grip.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      inkBar.style.left = startRect.left + dx + "px";
      inkBar.style.top = startRect.top + dy + "px";
      inkBar.style.right = "auto";
      inkBar.style.bottom = "auto";
      inkBar.style.transform = "none";
    });
    grip.addEventListener("pointerup", function (e) {
      if (!dragging) return;
      dragging = false;
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved) inkSnapBar();
    });

    // 页面尺寸变化 → 重排校正（缩放状态下不校正）
    var reflowTimer = null;
    window.addEventListener("resize", function () {
      if (reflowTimer) window.clearTimeout(reflowTimer);
      reflowTimer = window.setTimeout(function () {
        reflowTimer = null;
        if (ink.zoom === 1 && state.strokes.length) {
          inkApplyReflow();
          inkRender();
        }
        inkZoomSpace();
      }, 200);
    });
    window.addEventListener("load", function () {
      if (ink.zoom === 1 && state.strokes.length) {
        inkApplyReflow();
        inkRender();
      }
    });
  }

  // ---------------------------------------------------------------- 事件绑定

  function setupQuestionEvents() {
    document.addEventListener("change", function (e) {
      if (!inHostScope(e.target)) return;
      var t = e.target;
      if (t && (t.type === "radio" || t.type === "checkbox")) {
        scheduleSave();
      }
      if (t && t.classList && t.classList.contains("q-doubt")) scheduleSave();
    });
    document.addEventListener("input", function (e) {
      if (!inHostScope(e.target)) return;
      var t = e.target;
      if (!t) return;
      if (
        t.classList &&
        (t.classList.contains("q-why") || t.classList.contains("q-wrong-reason"))
      ) {
        scheduleSave();
      }
    });
  }

  function setupZoneEvents() {
    var zone = ensureZone();
    // 右侧把手：点开/收起悬浮面板
    var tab = document.querySelector("[data-hvv-panel-tab]");
    if (tab) {
      tab.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      });
    }
    zone.addEventListener("click", function (e) {
      // 关闭按钮
      if (e.target.closest("[data-hvv-panel-close]")) {
        closePanel();
        return;
      }
      var btn = e.target.closest("[data-hvv-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-hvv-act");
      if (act === "note") {
        openPop("新笔记", "", false, function (res) {
          if (!res) return;
          addNote(res.text);
          renderZone();
          scheduleSave();
        });
      } else if (act === "mark") {
        openPop("标记当前位置", "", false, function (res) {
          if (!res) return;
          addMark({ text: res.text, doubt: res.doubt });
          renderZone();
          applyMarks();
          scheduleSave();
        });
      } else if (act === "save") {
        saveNow();
      }
    });
  }

  var scrollTimer = null;
  var scrollBoundTo = null;

  function onScrollEvent() {
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(function () {
      scrollTimer = null;
      updateCurrentQuestion();
      if (updateSectionProgress()) scheduleSave();
    }, 250);
  }

  /**
   * 把滚动监听绑到正确的目标上。
   *
   * iframe 宿主：window 自己滚。
   * page 宿主：MD 阅读视图是**容器**在滚，而 scroll 事件不冒泡，
   *   所以必须直接绑到那个容器上，否则章节进度永远不更新。
   */
  function bindScrollTarget(el) {
    if (scrollBoundTo === el) return;
    if (scrollBoundTo) {
      scrollBoundTo.removeEventListener("scroll", onScrollEvent);
    }
    scrollBoundTo = el || null;
    if (scrollBoundTo) {
      scrollBoundTo.addEventListener("scroll", onScrollEvent, { passive: true });
    }
  }

  function setupScrollEvents() {
    bindScrollTarget(HOST.kind === "page" ? HOST.scroll : window);
    window.addEventListener("resize", function () {
      updateSectionProgress();
    });
    window.addEventListener("beforeunload", function () {
      if (mode === "plugin") saveNow();
    });
  }

  // ---------------------------------------------------------------- 提示

  function ensureBanner() {
    var b = $("#hvv-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "hvv-banner";
      b.className = "hvv-banner";
      document.body.insertBefore(b, document.body.firstChild);
    }
    return b;
  }

  function showBanner(text, isError) {
    var b = ensureBanner();
    b.textContent = text;
    b.classList.add("is-on");
    b.classList.toggle("is-error", !!isError);
  }

  function hideBanner() {
    var b = $("#hvv-banner");
    if (b) b.classList.remove("is-on");
  }

  function ensureStatus() {
    var s = $("#hvv-status");
    if (!s) {
      s = document.createElement("div");
      s.id = "hvv-status";
      s.className = "hvv-status";
      hostUiRoot().appendChild(s);
    }
    return s;
  }

  function showStatus(text, isError) {
    var s = ensureStatus();
    s.textContent = text;
    s.classList.add("is-on");
    s.classList.toggle("is-error", !!isError);
    if (saveStatusTimer) window.clearTimeout(saveStatusTimer);
    saveStatusTimer = window.setTimeout(function () {
      s.classList.remove("is-on");
    }, 1500);
  }

  function clockNow() {
    var d = new Date();
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0")
    );
  }

  function clockOf(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return (
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      " " +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  // ---------------------------------------------------------------- 元数据

  function readMeta() {
    var el = document.getElementById(META_ID);
    if (!el) return;
    try {
      var parsed = JSON.parse(el.textContent || "{}");
      if (isPlainObject(parsed)) meta = parsed;
    } catch (e) {
      /* ignore */
    }
  }

  function checkConsistency() {
    var metaCount = Array.isArray(meta.questions) ? meta.questions.length : 0;
    var domCount = questionBlocks().length;
    lastMetaQuestionCount = domCount;
    if (metaCount && domCount && metaCount !== domCount) {
      showBanner(
        "题库与正文不一致：正文有 " +
          domCount +
          " 道题，元数据里有 " +
          metaCount +
          " 道题。判分可能不准。",
        true,
      );
    }
  }

  // ---------------------------------------------------------------- 自检

  function runSelftest(req) {
    var answerMap = isPlainObject(req.answer)
      ? req.answer
      : isPlainObject(req.answers)
        ? req.answers
        : null;
    if (answerMap) {
      Object.keys(answerMap).forEach(function (qid) {
        setAnswer(qid, answerMap[qid]);
      });
    }
    if (req.noteText) addNote(req.noteText);
    if (req.annotationText) {
      var first = contentEls("p, li")[0];
      addAnnotation({
        quote: first ? (first.textContent || "").trim().slice(0, 40) : "",
        text: req.annotationText,
      });
    }
    if (typeof req.scrollTo === "number") {
      scrollToPos(req.scrollTo);
    }
    if (req.markText) addMark({ text: req.markText });
    // 手写层自检
    if (req.inkMode === true) inkSetActive(true);
    if (isPlainObject(req.inkStroke)) {
      var st = req.inkStroke;
      state.strokes.push({
        id: typeof st.id === "string" ? st.id : uid("s"),
        d: typeof st.d === "string" ? st.d : "",
        color: typeof st.color === "string" ? st.color : "ink",
        width: Number(st.width) || 4,
        opacity: typeof st.opacity === "number" ? st.opacity : 1,
        anchor: isPlainObject(st.anchor) ? st.anchor : null,
        at: nowIso(),
        saved: true,
      });
      inkRender();
    }
    if (req.inkSave === true) inkSave();
    if (req.inkClearAll === true) {
      var nowTs = nowIso();
      state.strokes = state.strokes.map(function (s) {
        if (s.deleted) return s;
        return { id: s.id, deleted: true, at: nowTs };
      });
      ink.draft = [];
      inkRender();
    }
    renderZone();
    applyMarks();
    updateJudges();
    saveNow();
  }

  function setAnswer(qid, value) {
    var block = document.querySelector(
      '[data-qid="' + cssEscape(qid) + '"]',
    );
    if (!block) return false;
    var vals = Array.isArray(value) ? value : [value];
    $$('input[type="radio"], input[type="checkbox"]', block).forEach(function (i) {
      i.checked = vals.indexOf(i.value) >= 0;
    });
    return true;
  }

  // ---------------------------------------------------------------- 启动

  function init() {
    injectStyles();
    hostUiRoot().classList.add("hvv-root");
    // 给正文根打个标记：画笔模式禁选中和「正文在哪」都靠它，不用写死 #content
    // （page 宿主下正文根由 attachPage 决定，init 时还没有）
    if (HOST.kind !== "page") {
      var root = contentRoot();
      if (root && root !== document.body) root.classList.add("hvv-content-root");
    }
    readMeta();
    sectionRanges = computeSections();
    ensureZone();
    setupQuestionEvents();
    setupZoneEvents();
    setupSelectionTool();
    setupPager();
    setupTouchFlip();
    setupImages();
    setupScrollEvents();
    setupInk();
    ensureHaltButton();
    renderZone();
    updateJudges();
    checkConsistency();

    if (HOST.kind !== "page") {
      window.addEventListener("message", onMessage);
    }
    startHandshake();
  }

  // ---------------------------------------------------------------- page 宿主接口

  /**
   * 绑定到当前服务的那一篇 MD（page 宿主专用）。
   *
   * Obsidian 可以同时开着好几篇 MD，runtime 只有一个，
   * 所以切标签页时不是「重新初始化」，而是「换一个服务对象」。
   */
  function attachPage(opts) {
    opts = opts || {};
    HOST.kind = "page";
    HOST.root = opts.root || null;
    HOST.scroll = opts.scroll || null;
    if (opts.transport) HOST.transport = opts.transport;

    // 换一篇 → 状态清零，不能把上一篇的答案带到下一篇
    state = freshState();

    // 正文根标记换地方
    if (HOST.prevRoot && HOST.prevRoot !== HOST.root) {
      HOST.prevRoot.classList.remove("hvv-content-root");
    }
    if (HOST.root) HOST.root.classList.add("hvv-content-root");
    HOST.prevRoot = HOST.root;

    // 滚动容器换了，滚动监听要跟着换
    bindScrollTarget(HOST.scroll);

    readMeta();
    sectionRanges = computeSections();
    renderZone();
    applyMarks();
    updateJudges();
    inkRender();
    mode = "plugin";
    if (typeof opts.onReady === "function") opts.onReady();
  }

  /** 解除绑定（MD 标签页被关掉，或切到非 MD 视图） */
  function detachPage() {
    if (HOST.prevRoot) HOST.prevRoot.classList.remove("hvv-content-root");
    HOST.prevRoot = null;
    HOST.root = null;
    HOST.scroll = null;
    bindScrollTarget(null);
    state = freshState();
    renderZone();
    inkRender();
  }

  /**
   * 临时关停 / 恢复。
   *
   * 关停后：手写层、翻页键、选中批注、触屏分区翻页全部让位，
   * MD 正文恢复成完全可点选、可编辑的状态。
   * 只有右下角那个开关按钮本身仍然可点（否则关掉就再也开不回来了）。
   */
  function setPaused(on) {
    HOST.paused = !!on;
    hostUiRoot().classList.toggle("is-paused", HOST.paused);
    if (haltBtn) {
      haltBtn.classList.toggle("is-paused", HOST.paused);
      haltBtn.textContent = HOST.paused ? "▶" : "⏸";
      haltBtn.title = HOST.paused
        ? "恢复插件"
        : "临时关停插件（关掉后可以正常选中和编辑正文）";
    }
    if (HOST.paused) {
      if (typeof inkExit === "function") {
        try {
          inkExit();
        } catch (e) {
          /* ignore */
        }
      }
    }
    return HOST.paused;
  }

  // 供自动化测试与外部脚本使用的接口
  window.__HTML_VIEW__ = {
    version: VERSION,
    // ---- page 宿主（MD 阅读视图）专用接口 ----
    attachPage: attachPage,
    detachPage: detachPage,
    setPaused: setPaused,
    isPaused: function () {
      return HOST.paused;
    },
    getHostKind: function () {
      return HOST.kind;
    },
    getMode: function () {
      return mode;
    },
    getState: function () {
      return collectPayload();
    },
    getMeta: function () {
      return meta;
    },
    getSections: function () {
      return sectionRanges.map(function (r) {
        return { id: r.id, title: r.title };
      });
    },
    getImageState: function () {
      return imageState;
    },
    saveNow: saveNow,
    setAnswer: setAnswer,
    addNote: addNote,
    addAnnotation: addAnnotation,
    addMark: addMark,
    renderZone: renderZone,
    applyMarks: applyMarks,
    updateJudges: updateJudges,
    runSelftest: runSelftest,
    openOverlayFor: function (index) {
      var imgs = contentEls("img");
      if (imgs[index]) openOverlay(imgs[index]);
    },
    advanceImage: advanceImage,
    closeOverlay: closeOverlay,
    /** 翻页键（供自动化测试与外部脚本使用） */
    pager: {
      flip: flipPage,
      getFlipCount: function () {
        return flipCount;
      },
      getPos: pagerPos,
    },
    /** 手写标注层（供自动化测试与外部脚本使用） */
    ink: {
      getState: inkState,
      setActive: inkSetActive,
      exit: inkExit,
      save: inkSave,
      clearDraft: inkClearDraft,
      clearAll: inkClearAll,
      eraseAt: function (x, y) {
        inkEraseAt(x, y);
      },
      zoomIn: function (x, y) {
        inkZoomIn(x, y);
      },
      zoomReset: function () {
        inkZoomReset();
      },
      reflow: function () {
        var n = inkApplyReflow();
        inkRender();
        return n;
      },
      render: inkRender,
      setBrush: function (color, width) {
        ink.color = color || ink.color;
        ink.width = width || ink.width;
        inkUpdateBarState();
      },
      setEraser: function (on) {
        ink.eraser = on === true;
        inkUpdateBarState();
      },
      /** 供测试直接塞一笔（模拟已保存笔迹） */
      addSavedStroke: function (entry) {
        if (!isPlainObject(entry)) return null;
        var s = {
          id: typeof entry.id === "string" ? entry.id : uid("s"),
          d: typeof entry.d === "string" ? entry.d : "",
          color: typeof entry.color === "string" ? entry.color : "ink",
          width: Number(entry.width) || 4,
          opacity: typeof entry.opacity === "number" ? entry.opacity : 1,
          anchor: isPlainObject(entry.anchor) ? entry.anchor : null,
          at: nowIso(),
          saved: true,
        };
        state.strokes.push(s);
        inkRender();
        renderZone();
        return s;
      },
      /** 模拟画一笔（直接注入点，不依赖真实指针事件） */
      drawStroke: function (points, opts) {
        if (!points || !points.length) return null;
        var o = isPlainObject(opts) ? opts : {};
        var stroke = {
          id: uid("s"),
          d: "",
          color: o.color || ink.color,
          width: o.width || ink.width,
          opacity: inkOpacityOf(o.color || ink.color),
          pts: points.map(function (p) {
            return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
          }),
          createdAt: Date.now(),
          at: nowIso(),
          saved: false,
        };
        stroke.d = inkPointsToPath(stroke.pts);
        ink.draft.push(stroke);
        inkRender();
        inkReport();
        return stroke;
      },
      path: {
        pointsToPath: inkPointsToPath,
        pathToPoints: inkPathToPoints,
        translatePath: inkTranslatePath,
      },
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
