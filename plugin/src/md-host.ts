/**
 * MD 阅读视图的宿主：把页面运行时接到 Obsidian 主页面，并把数据写回 MD 的 frontmatter。
 *
 * 为什么是「同页注入」而不是 iframe：
 *  - 沙箱 iframe 里加载不了 Obsidian 的 app:// 资源（图片会挂）
 *  - Obsidian 可以同时开着好几篇 MD，需要多实例能力，而 iframe 天然是隔离的
 *  - 同页方案保留 Obsidian 原生主题、文档级选区和快捷键
 *
 * 代价是必须小心别劫持 Obsidian 自己的界面：
 *  - runtime 自己的界面元素全部挂在一个专用壳里（.hvv-page-root），不碰 body 的 class
 *  - 所有文档级监听器都用 inHostScope() 把关：事件不在当前正文根里就当没看见
 *  - 临时关停（⏸ 按钮）之后连正文根内的交互也一并让位，正文恢复成完全可编辑
 *
 * 数据存放：MD 的 frontmatter `hvv` 字段（Obsidian 官方 fileManager.processFrontMatter）。
 * 与 HTML 版共用同一套数据形状和合并规则，差别只在存放位置。
 */

import { MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";

import { FileLock } from "./file-lock.ts";
import { MSG_INK, MSG_SAVE, MSG_STATE, sanitizePayload } from "./protocol.ts";
import { mergeProgress, stripTombstones, type Block } from "./merge.ts";
import {
  MD_PROGRESS_SCHEMA,
  buildMdFrontmatter,
  extractMdProgress,
  isMdProgressData,
} from "./md-progress.ts";
import RUNTIME_SOURCE from "runtime-source";

/** runtime 暴露在 window 上的接口（page 宿主用得到的那部分） */
export interface HvvRuntimeApi {
  version: string;
  attachPage(opts: {
    root: HTMLElement;
    scroll: HTMLElement | null;
    transport?: { post(type: string, payload: unknown): void };
    /** 重新接管同一篇时为 true：保留内存里的临时涂鸦草稿 */
    keepDraft?: boolean;
    onReady?: () => void;
  }): void;
  detachPage(opts?: { save?: boolean }): void;
  setPaused(on: boolean): boolean;
  isPaused(): boolean;
  isAttached(): boolean;
  getHostKind(): string;
  getState(): Block;
  applyProgressData(raw: unknown): void;
  showStatus(text: string, isError?: boolean): void;
}

interface HvvWindow {
  __HTML_VIEW__?: HvvRuntimeApi;
  __HVV_HOST__?: {
    kind?: string;
    transport?: { post(type: string, payload: unknown): void };
    features?: Record<string, boolean>;
  };
}

export interface MdHostOptions {
  app: App;
  pluginVersion: string;
  log(message: string): void;
}

interface Attached {
  path: string;
  file: TFile;
  root: HTMLElement;
  scroll: HTMLElement | null;
}

function makeDeviceId(): string {
  try {
    const c: Crypto | undefined = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      return `device-${c.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* ignore */
  }
  return `device-${Math.random().toString(36).slice(2, 10)}`;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getMetaUpdatedAt(block: unknown): string | null {
  if (!isPlain(block)) return null;
  const meta = block.meta;
  if (!isPlain(meta)) return null;
  const at = meta.updatedAt;
  return typeof at === "string" ? at : null;
}

function clockNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class MdHost {
  private readonly app: App;
  private readonly opts: MdHostOptions;
  private readonly lock = new FileLock();
  private readonly deviceId = makeDeviceId();

  private attached: Attached | null = null;
  /** 上一次写出去的进度（重新挂载时直接推回去，避免闪一下空白） */
  private lastPayload: Block | null = null;
  /** lastPayload 属于哪一篇（换篇必须清空，否则会把上一篇的数据推给下一篇） */
  private lastPayloadPath: string | null = null;
  /** 上一次写入内容的指纹：内容没变就不重复写（防止「写→重渲染→再写」的死循环） */
  private lastFingerprint = "";
  /** 自己刚写完的时间窗：这段时间内的外部改动提示不算数 */
  private selfWriteUntil = 0;
  /** 文件改动后排的复查计时器 */
  private resyncTimer: number | null = null;

  constructor(opts: MdHostOptions) {
    this.opts = opts;
    this.app = opts.app;
  }

  // ---------------------------------------------------------------- runtime

  private api(): HvvRuntimeApi | null {
    const w = window as unknown as HvvWindow;
    return w.__HTML_VIEW__ ?? null;
  }

  /**
   * 把 runtime 注入 Obsidian 主页面。
   *
   * 整个 Obsidian 会话就是一个 document，所以只注一次：
   * 插件重新加载时 window.__HTML_VIEW__ 还在，就不重复注。
   */
  private ensureRuntime(): boolean {
    const w = window as unknown as HvvWindow;
    if (w.__HTML_VIEW__) return true;
    if (!document.body) return false;
    // 宿主信息必须在 runtime 跑起来之前写好：它一上来就要知道自己是谁
    w.__HVV_HOST__ = {
      kind: "page",
      transport: {
        post: (type: string, payload: unknown): void => {
          this.onRuntimeMessage(type, payload);
        },
      },
    };
    try {
      const script = document.createElement("script");
      script.setAttribute("data-hvv-runtime", "1");
      script.textContent = RUNTIME_SOURCE;
      document.body.appendChild(script);
    } catch (err) {
      this.opts.log(`runtime 注入失败：${String(err)}`);
      return false;
    }
    if (!w.__HTML_VIEW__) {
      this.opts.log("runtime 注入后没有出现 __HTML_VIEW__，可能被 CSP 拦了");
      return false;
    }
    this.opts.log("runtime 已注入 Obsidian 主页面");
    return true;
  }

  // ---------------------------------------------------------------- 挂载

  /**
   * 同步「当前服务的是哪一篇 MD」。
   *
   * 三种触发时机都走这里：
   *  - 切换标签页（active-leaf-change）
   *  - 布局变化（layout-change）
   *  - MD 重新渲染完成（markdown post processor）
   */
  sync(): void {
    if (!this.ensureRuntime()) return;
    const api = this.api();
    if (!api) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.detach();
      return;
    }
    // 只在阅读视图接管；实时预览（编辑态）不碰——
    // 编辑的时候要能正常选中和改字，而且用户说的是「阅读的时候生效」
    if (view.getMode() !== "preview") {
      this.detach();
      return;
    }
    const file = view.file;
    if (!file) {
      this.detach();
      return;
    }
    const root = this.resolveContentRoot(view);
    if (!root) {
      // 阅读视图还没渲染出来，等 post-processor 回调再来一次
      return;
    }
    const scroll = this.resolveScrollContainer(root);

    const cur = this.attached;
    if (cur && cur.path === file.path && cur.root === root) {
      // 同一篇、同一块 DOM：正常情况什么都不用做。
      //
      // 但有个例外：Obsidian 重新渲染这一篇时，会把正文根里的内容清空重建，
      // 我们挂在正文根里的手写画布会被一起抹掉。
      // 画布没了就重新接管一次（顺带把进度和内存里的涂鸦草稿再推一遍）。
      if (root.querySelector("svg.hvv-ink")) return;
      this.opts.log("MD 正文被重渲染，手写画布已被清掉，重新接管");
      // 这一步是「同一篇重新接管」，不能写回：
      // 写回会触发重渲染 → 又要重新接管，转成死循环。
      this.detach(false);
      this.attach(file, root, scroll, true);
      return;
    }
    if (cur) {
      const sameFile = cur.path === file.path;
      this.opts.log(`MD 切换：${cur.path} → ${file.path}`);
      this.detach();
      this.attach(file, root, scroll, sameFile);
      return;
    }
    this.attach(file, root, scroll);
  }

  /** 读一篇 MD 的 frontmatter（Obsidian 的缓存里就有解析好的对象） */
  private readFrontmatter(file: TFile): Record<string, unknown> | null {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    return isPlain(fm) ? fm : null;
  }

  /**
   * 找阅读视图的正文根。
   *
   * Obsidian 的阅读视图 DOM 大致是：
   *   .markdown-preview-view  ← 滚动容器
   *     └ .markdown-preview-sizer  ← 正文根（手写画布要挂在这一层）
   *       └ 渲染出来的内容
   *
   * 各版本类名有出入，所以按优先级多试几个。
   */
  private resolveContentRoot(view: MarkdownView): HTMLElement | null {
    const container = view.previewMode?.containerEl;
    if (!container) return null;
    const candidates = [
      ".markdown-preview-sizer",
      ".markdown-preview-section",
      ".markdown-reading-view",
    ];
    for (const sel of candidates) {
      const el = container.querySelector(sel);
      if (el instanceof HTMLElement) return el;
    }
    return container instanceof HTMLElement ? container : null;
  }

  /**
   * 找真正在滚的那个容器。
   *
   * 阅读视图里滚的是容器而不是 window，scroll 事件又不冒泡，
   * 绑错地方的话章节进度永远不更新。
   */
  private resolveScrollContainer(root: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = root.parentElement;
    while (node && node !== document.body) {
      const st = window.getComputedStyle(node);
      const oy = st.overflowY;
      if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
      node = node.parentElement;
    }
    return null;
  }

  private attach(
    file: TFile,
    root: HTMLElement,
    scroll: HTMLElement | null,
    keepDraft = false,
  ): void {
    const api = this.api();
    if (!api) return;
    // 换篇：手里那份数据是上一篇的，不能推给这一篇
    if (this.lastPayloadPath !== file.path) {
      this.lastPayload = null;
      this.lastPayloadPath = file.path;
      this.lastFingerprint = "";
    }
    this.attached = { path: file.path, file, root, scroll };
    this.opts.log(
      `MD 已接管：${file.path} root=${root.className || root.tagName} scroll=${
        scroll ? scroll.className : "window"
      }`,
    );
    /**
     * 保存目标在这一刻**捕获**下来，不在回调里再问「当前接管的是谁」。
     *
     * 原因：切篇时旧页面会先 detach（里面会触发一次保存），
     * 那次保存属于**旧的那篇**；如果回调里去看当前接管对象，
     * 就会把上一篇的数据写到新文件头上。
     */
    const target = file;
    api.attachPage({
      root,
      scroll,
      keepDraft,
      transport: {
        post: (type: string, payload: unknown): void => {
          if (type === MSG_SAVE) {
            void this.saveTo(target, payload);
            return;
          }
          this.onRuntimeMessage(type, payload);
        },
      },
      onReady: () => {
        void this.pushProgress(target);
      },
    });
  }

  /**
   * 解除接管。
   *
   * `save` 区分两种解除：
   *  - 真的切走（换文件、关标签页、切到非 MD 视图）→ 要存，
   *    否则最后一段滚动位置就丢了。
   *  - 「同一篇被重新接管」（Obsidian 重渲染后画布被清空）→ **不能存**：
   *    存下去会写文件 → 又触发重渲染 → 又要重新接管，转成死循环。
   */
  private detach(save = true): void {
    const api = this.api();
    if (this.attached) {
      this.opts.log(`MD 解除接管：${this.attached.path}${save ? "" : "（不写回）"}`);
    }
    this.attached = null;
    if (api) {
      try {
        api.detachPage({ save });
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------- 数据

  /**
   * 把磁盘上的进度推进页面。
   *
   * 刚写完 frontmatter 时 Obsidian 会重渲染这一篇，
   * 重渲染完 post-processor 会再触发一次 → 重新 attach → 这里再推一遍，
   * 用户看到的进度、涂鸦、笔记都还在。
   *
   * 取数优先级：**文件原文说了算**。
   *  - 文件里没有 hvv 字段 → 这篇就是没数据（也可能是被外部重置了），
   *    内存里那份旧数据要作废，否则会被「复活」写回文件。
   *  - 文件里有 hvv → 取缓存里的；缓存比内存旧（我们刚写完还没跟上）就用内存那份。
   */
  private async pushProgress(file: TFile): Promise<void> {
    const api = this.api();
    if (!api) return;
    const cur = this.attached;
    if (!cur || cur.path !== file.path) return;

    const hasHvv = await this.fileHasHvv(file);
    if (!hasHvv) {
      if (this.lastPayload) {
        this.opts.log("MD 文件里没有 hvv 字段，丢弃内存里的旧数据");
      }
      this.lastPayload = null;
      this.lastFingerprint = "";
      api.applyProgressData({});
      return;
    }

    const fm = this.readFrontmatter(file);
    const disk = extractMdProgress(fm).data ?? null;
    const diskAt = getMetaUpdatedAt(disk);
    const memAt = getMetaUpdatedAt(this.lastPayload);
    const use =
      memAt && diskAt && memAt > diskAt ? this.lastPayload : (disk ?? this.lastPayload);
    if (!use) {
      this.opts.log(`MD 进度为空：${file.path}`);
      api.applyProgressData({});
      return;
    }
    api.applyProgressData(use);
    this.opts.log(
      `MD 进度已推送 ${file.path} notes=${Array.isArray(use.notes) ? use.notes.length : 0}`,
    );
  }

  /**
   * 文件原文里有没有 hvv 字段。
   *
   * metadataCache 是异步刷新的，插件刚写完或文件刚被外部改过的那一刻，
   * 缓存里的 frontmatter 可能还是旧的、甚至还没有 hvv。
   * 直接看原文最保险。
   */
  private async fileHasHvv(file: TFile): Promise<boolean> {
    try {
      const text = await this.app.vault.read(file);
      return /(^|\n)[ \t]*hvv[ \t]*:/.test(text);
    } catch {
      return true; // 读不到就别乱判，按「有」处理
    }
  }

  private onRuntimeMessage(type: string, payload: unknown): void {
    if (type === MSG_STATE) {
      this.opts.log(`MD 页面状态：${JSON.stringify(payload).slice(0, 800)}`);
      return;
    }
    if (type === MSG_INK) {
      this.opts.log(`MD 手写层状态：${JSON.stringify(payload).slice(0, 400)}`);
    }
  }

  /**
   * 写回 frontmatter。
   *
   * 合并规则与 HTML 版完全一致（mergeProgress），
   * 差别只在于最后落到 frontmatter 而不是 HTML 的 <script> 数据块。
   *
   * `file` 是 attach 时捕获的目标文件，**不能**改成「当前接管的那篇」——
   * 切篇瞬间旧页面发出的残留保存属于旧文件。
   */
  private async saveTo(file: TFile, raw: unknown): Promise<void> {
    const clean = sanitizePayload(raw);
    if (!clean.ok) {
      this.opts.log(`MD 保存被拒绝：${clean.reason}`);
      this.toast(`保存被拒绝：${clean.reason}`, true);
      return;
    }
    const incoming = clean.payload as Block;

    // 内容跟上次写的一模一样 → 不写。
    // 这一步是防死循环的关键：写 frontmatter 会触发 Obsidian 重渲染，
    // 重渲染完 runtime 会重新上报一次状态，不挡一下就会「写→渲染→写」来回转。
    const fingerprint = this.fingerprintOf(incoming);
    if (fingerprint && fingerprint === this.lastFingerprint) {
      this.opts.log("MD 内容没有变化，跳过写入");
      return;
    }
    if (this.lastFingerprint) {
      this.opts.log(
        `MD 内容有变化：${this.fingerprintDiff(this.lastPayload, incoming)}`,
      );
    }

    try {
      let kept = 0;
      await this.lock.run(file.path, async () => {
        /**
         * 用 processFrontMatter「现读现写」：
         * 它给回调的是**从文件当前内容解析出来的** frontmatter（不是缓存），
         * 我们在同一个回调里合并并写回 hvv —— 一次文件写完，不会有缓存滞后的窗口。
         */
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          const diskBlock = extractMdProgress(frontmatter).data ?? {};
          const { merged, keptFromDisk } = mergeProgress(diskBlock, incoming);
          kept = keptFromDisk.length;

          const meta = isPlain(merged.meta) ? merged.meta : {};
          merged.meta = {
            ...meta,
            schema: MD_PROGRESS_SCHEMA,
            updatedAt: new Date().toISOString(),
            updatedBy: this.deviceId,
          };
          if (!isMdProgressData(merged)) {
            throw new Error("进度数据形状不合法，拒绝覆盖 frontmatter");
          }

          // 只改 hvv 这一个键，其他字段原样保留
          const next = buildMdFrontmatter(frontmatter, merged);
          for (const key of Object.keys(frontmatter)) delete frontmatter[key];
          Object.assign(frontmatter, next);
          if (this.attached && this.attached.path === file.path) {
            this.lastPayload = merged;
          }
        });

        this.selfWriteUntil = Date.now() + 1500;
        if (this.attached && this.attached.path === file.path) {
          this.lastPayloadPath = file.path;
          const payload = this.lastPayload;
          this.lastFingerprint = payload ? this.fingerprintOf(payload) : "";
        }
      });
      this.opts.log(`MD 写回成功 ${file.path} kept=${kept}`);
      /**
       * 把合并结果推回页面，让页面和磁盘上的内容一致。
       *
       * 不推的话，页面里的 meta.updatedAt 永远比磁盘旧，
       * 下一次合并就会认为「磁盘更新」而把磁盘的值保留下来——
       * 写回的内容和页面看到的不一样，容易转成反复写。
       */
      const api = this.api();
      const merged = this.lastPayload;
      if (api && merged && this.attached && this.attached.path === file.path) {
        api.applyProgressData(merged);
      }
      this.toast(`已保存于 ${clockNow()}${kept > 0 ? ` · 已合并其他设备的修改` : ""}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log(`MD 写回失败：${msg}`);
      this.toast(`保存失败：${msg}`, true);
      new Notice(`MD 保存失败：${msg}`);
    }
  }

  /**
   * 内容指纹：用来判断「跟上次写的是不是同一份」。
   *
   * 只看用户看得见的那几项（答案、笔记、批注、标记、涂鸦、章节进度、滚动位置），
   * 不看 meta（里面的 updatedAt 每次写都会变，拿它比会永远不相等）。
   * 字段顺序固定，嵌套对象按键排序，保证同一份内容算出同一个指纹。
   */
  private fingerprintOf(payload: Block): string {
    const view = {
      answers: payload.answers ?? {},
      notes: payload.notes ?? [],
      annotations: payload.annotations ?? [],
      marks: payload.marks ?? [],
      strokes: payload.strokes ?? [],
      sectionProgress: payload.sectionProgress ?? {},
      scrollY: payload.scrollY ?? 0,
      scrollPercent: payload.scrollPercent ?? 0,
      readDone: payload.readDone === true,
      currentQuestion: payload.currentQuestion ?? 0,
    };
    try {
      return JSON.stringify(this.canonicalize(view));
    } catch {
      return "";
    }
  }

  /** 递归排序键，让指纹不受对象键顺序影响 */
  private canonicalize(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.canonicalize(x));
    if (isPlain(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = this.canonicalize(v[key]);
      return out;
    }
    return v;
  }

  /**
   * 指纹差了什么（只给日志看，用来定位「为什么又写了一次」）。
   *
   * 不做成门禁逻辑，只做诊断——写回次数异常时能一眼看出是哪一项在抖。
   */
  private fingerprintDiff(a: Block | null, b: Block): string {
    if (!a) return "（没有上一份）";
    const keys = ["answers", "notes", "annotations", "marks", "strokes", "sectionProgress", "scrollY", "scrollPercent", "readDone", "currentQuestion"];
    const parts: string[] = [];
    for (const key of keys) {
      const x = JSON.stringify(this.canonicalize(a[key] ?? null));
      const y = JSON.stringify(this.canonicalize(b[key] ?? null));
      if (x !== y) {
        parts.push(`${key}(${String(x).slice(0, 60)}→${String(y).slice(0, 60)})`);
      }
    }
    return parts.length ? parts.join(" ") : "（指纹算出来一样，但比较用了别的口径）";
  }

  /**
   * 磁盘上的这篇被别处改了（比如另一台设备同步过来）。
   *
   * 把磁盘上的版本推给页面，让用户看到的是最新的一份。
   */
  notifyExternalChange(path: string): void {
    const cur = this.attached;
    if (!cur || cur.path !== path) return;
    if (Date.now() < this.selfWriteUntil) return;
    void (async () => {
      const fm = this.readFrontmatter(cur.file);
      const disk = extractMdProgress(fm).data;
      if (!disk) return;
      const diskAt = getMetaUpdatedAt(disk);
      const pageAt = getMetaUpdatedAt(this.lastPayload);
      if (!diskAt) return;
      // 磁盘不比页面新就忽略：
      // 我们刚写完时缓存还没跟上，缓存里是旧的那份，
      // 拿它盖回页面等于把刚保存的东西又抹了。
      if (pageAt && diskAt <= pageAt) return;
      this.lastPayload = disk;
      this.lastPayloadPath = cur.path;
      this.lastFingerprint = "";
      const api = this.api();
      if (!api) return;
      api.applyProgressData(disk);
      this.toast("这篇 MD 在别处被改过，已刷新页面上的进度");
    })();
  }

  /** 清理 frontmatter 里的墓碑条目 */
  async cleanTombstones(): Promise<void> {
    const cur = this.attached;
    if (!cur) return;
    try {
      await this.lock.run(cur.path, async () => {
        await this.app.fileManager.processFrontMatter(cur.file, (frontmatter) => {
          const block = extractMdProgress(frontmatter).data;
          if (!block) return;
          const cleaned = stripTombstones(block);
          const next = buildMdFrontmatter(frontmatter, cleaned);
          for (const key of Object.keys(frontmatter)) delete frontmatter[key];
          Object.assign(frontmatter, next);
          this.lastPayload = cleaned;
        });
        this.selfWriteUntil = Date.now() + 1500;
        this.lastPayloadPath = cur.path;
        const payload = this.lastPayload;
        this.lastFingerprint = payload ? this.fingerprintOf(payload) : "";
      });
      new Notice("已清理已删除条目（墓碑）。");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`清理失败：${msg}`);
    }
  }

  /** 冒个泡（复用 runtime 的状态条样式） */
  private toast(text: string, isError = false): void {
    const api = this.api();
    if (!api) return;
    try {
      api.showStatus(text, isError);
    } catch {
      /* ignore */
    }
  }

  /** 插件卸载时把界面收干净 */
  dispose(): void {
    if (this.resyncTimer !== null) {
      window.clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    this.detach();
    const w = window as unknown as HvvWindow;
    if (w.__HVV_HOST__) {
      delete w.__HVV_HOST__;
    }
  }

  /**
   * 文件被改过之后，Obsidian 会重渲染这一篇（正文根里的内容会被清空重建）。
   *
   * 重渲染完成的时机不好抓（Obsidian 没给回调），
   * 所以这里排一个延后复查：真到重渲染了，
   * sync() 会发现手写画布没了并重新接管。
   */
  scheduleResync(delay = 700): void {
    if (this.resyncTimer !== null) window.clearTimeout(this.resyncTimer);
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null;
      this.sync();
    }, delay);
  }

  /** 当前接管的文件路径（给命令用） */
  get currentPath(): string | null {
    return this.attached?.path ?? null;
  }

  /** 把路径规整一下再查（用户在命令里给的可能是带 ./ 的相对路径） */
  normalize(path: string): string {
    return normalizePath(path);
  }
}
