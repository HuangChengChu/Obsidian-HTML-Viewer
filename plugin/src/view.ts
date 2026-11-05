import { ItemView, Notice, TFile, normalizePath } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";

import { FileLock } from "./file-lock.ts";
import {
  MSG_ACK,
  MSG_INK,
  MSG_LOAD,
  MSG_PROBE,
  MSG_PROGRESS,
  MSG_SAVE,
  MSG_SELFTEST,
  MSG_STATE,
  isInboundMessage,
  sanitizePayload,
} from "./protocol.ts";
import {
  applyProgress,
  extractContentMeta,
  extractProgress,
} from "./progress-codec.ts";
import { mergeProgress, stripTombstones } from "./merge.ts";
import { injectRuntime } from "./inject-runtime.ts";
import RUNTIME_SOURCE from "runtime-source";
import { buildReviewMarkdown } from "./review-export.ts";

export const VIEW_TYPE_HTML = "html-single-file-view";

const CONCURRENCY_NOTICE =
  "请勿在手机与电脑同时打开同一份 HTML 答题，否则进度可能互相覆盖。";

export interface HtmlViewHost {
  app: App;
  pluginVersion: string;
  log(message: string): void;
}

export interface SelftestRequest {
  answer?: Record<string, string | string[]>;
  noteText?: string;
  annotationText?: string;
  markText?: string;
  scrollTo?: number;
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

/** 每次加载生成一枚令牌，注入到 iframe 页面里，用于校验消息来源 */
function makeToken(): string {
  try {
    const c: Crypto | undefined = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      return c.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getMetaUpdatedAt(block: Record<string, unknown> | null): string | null {
  if (!block || !isPlain(block.meta)) return null;
  const at = block.meta.updatedAt;
  return typeof at === "string" ? at : null;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class HtmlQuizView extends ItemView {
  private host: HtmlViewHost;
  private file: TFile | null = null;
  private iframeEl: HTMLIFrameElement | null = null;
  private savedEl: HTMLElement | null = null;
  private keptEl: HTMLElement | null = null;
  private menuEl: HTMLElement | null = null;
  private menuNameEl: HTMLElement | null = null;
  private foldEl: HTMLButtonElement | null = null;
  private helpEl: HTMLElement | null = null;
  /** 已经提示过「别多设备同时开」的文件，避免每次重载都弹 */
  private readonly warnedFiles = new Set<string>();
  private readonly lock = new FileLock();
  private readonly deviceId = makeDeviceId();
  private token = makeToken();
  /** 已读入的 HTML 全文；iframe 可能晚于文件加载创建 */
  private currentHtml: string | null = null;
  private baselineUpdatedAt: string | null = null;
  private selfWriteUntil = 0;
  private selftestPayload: SelftestRequest | null = null;
  private probeRequested = false;
  private pageReady = false;
  private destroyed = false;
  /**
   * 换页门控：正在换页时先按住页面发来的保存请求。
   *
   * 换页会让旧文档卸载，而旧文档的 `beforeunload` 会把它的内存态保存回来。
   * 那份内存态可能已经过期（比如文件在磁盘上已经被改过），
   * 一旦放行，合并逻辑会把它并回文件里，旧数据就「复活」了。
   * 所以换页后按住 SAVE，等新页面握手（MSG_LOAD）再放行。
   */
  private awaitingFreshPage = false;
  private freshPageTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, host: HtmlViewHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return VIEW_TYPE_HTML;
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "HTML 视图";
  }

  getIcon(): string {
    return "glasses";
  }

  /** 当前视图是否还没绑定文件 */
  isEmpty(): boolean {
    return this.file === null;
  }

  get filePath(): string | null {
    return this.file?.path ?? null;
  }

  // ---------------------------------------------------------------- 生命周期

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("html-view-shell");

    // 说明抽屉（由底栏折叠菜单唤起，默认收起）
    const help = root.createDiv({ cls: "html-view-help is-hidden" });
    help.createEl("h4", { text: "HTML 单文件视图 · 使用说明" });
    const ul = help.createEl("ul");
    ul.createEl("li", {
      text: "进度、批注、笔记、涂鸦直接写回这个 HTML 文件本身，不产生任何附属文件。",
    });
    ul.createEl("li", {
      text: "别在手机与电脑同时打开同一份文件答题；插件会提示，但技术上仍可能互相覆盖。",
    });
    ul.createEl("li", {
      text: "正文选中文字可加评注/存疑；底部可打位置标记、记笔记、添加章节阅读进度。",
    });
    ul.createEl("li", {
      text: "双击图片：缩略 → 等宽 → 全屏；再双击回到缩略。",
    });
    ul.createEl("li", {
      text: "右侧上下两个半透明三角为翻页键，点击滚动一屏；触屏点按上半屏向上、下半屏向下。",
    });
    ul.createEl("li", {
      text: "右下角 ✏️ 进入手写模式：可直接在正文圈画、答题打草稿；点「💾 保存涂鸦」才写进文件。",
    });
    ul.createEl("li", {
      text: "「复制复习清单」把当前进度整理成 Markdown 复制到剪贴板，可直接喂给 AI。",
    });
    this.helpEl = help;

    // iframe
    const wrap = root.createDiv({ cls: "html-view-frame-wrap" });
    const iframe = wrap.createEl("iframe", { cls: "html-view-frame" });
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-modals allow-popups",
    );
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", "HTML 内容");
    this.iframeEl = iframe;

    // 文件可能先于 iframe 就绪（setState 早于 onOpen），这里补一次渲染
    if (this.currentHtml !== null) {
      this.applyHtmlToFrame(this.currentHtml);
    }

    // 底部状态条：左边折叠菜单，右边状态文本
    const status = root.createDiv({ cls: "html-view-status" });

    const menu = status.createDiv({ cls: "html-view-menu" });
    this.menuNameEl = menu.createDiv({ cls: "html-view-menu-name", text: "—" });
    menu.createDiv({ cls: "html-view-menu-hint", text: CONCURRENCY_NOTICE });
    const menuActions = menu.createDiv({ cls: "html-view-menu-actions" });
    const reloadBtn = menuActions.createEl("button", { text: "重新加载文件" });
    reloadBtn.addEventListener("click", () => {
      void this.reloadFile();
      this.closeMenu();
    });
    const reviewBtn = menuActions.createEl("button", { text: "复制复习清单" });
    reviewBtn.addEventListener("click", () => {
      void this.copyReviewList();
      this.closeMenu();
    });
    const helpBtn = menuActions.createEl("button", { text: "使用说明" });
    helpBtn.addEventListener("click", () => {
      this.toggleHelp();
      this.closeMenu();
    });
    this.menuEl = menu;

    const fold = status.createEl("button", {
      cls: "html-view-fold",
      text: "‹",
    });
    fold.setAttribute("aria-label", "更多操作");
    fold.setAttribute("title", "更多操作");
    fold.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });
    this.foldEl = fold;

    this.savedEl = status.createDiv({ cls: "html-view-status-saved", text: "就绪" });
    this.keptEl = status.createDiv({ cls: "html-view-status-kept" });

    // 点击别处收起菜单
    this.registerDomEvent(document, "click", () => {
      this.closeMenu();
    });

    window.addEventListener("message", this.handleMessage);

    // 没有绑定文件时，跟随当前活动的 html
    if (!this.file) {
      const active = this.host.app.workspace.getActiveFile();
      if (active && active.extension.toLowerCase() === "html") {
        await this.loadFile(active);
      }
    }
  }

  async onClose(): Promise<void> {
    this.destroyed = true;
    window.removeEventListener("message", this.handleMessage);
    if (this.iframeEl) {
      this.iframeEl.removeAttribute("srcdoc");
      this.iframeEl = null;
    }
    this.file = null;
  }

  /**
   * 把当前文件路径写进视图状态。
   *
   * 不写的话，Obsidian 重启后恢复工作区时这个标签页会变成空的
   * （用户得重新打开一次文件），而且插件也没法按路径复用已有标签页。
   */
  getState(): Record<string, unknown> {
    const base = super.getState() ?? {};
    return { ...base, path: this.file?.path ?? null };
  }

  async setState(state: unknown, result: unknown): Promise<void> {
    await super.setState(state as never, result as never);
    const path = this.resolvePathFromState(state);
    // 幂等：已经在显示这个文件就别再重载。
    // Obsidian 调整工作区布局时会重新下发视图状态，
    // 每次都重载会把 iframe 换掉，页面里的滚动位置和未保存内容都会被冲掉。
    if (path && path !== this.file?.path) {
      await this.loadPath(path);
    }
  }

  // ---------------------------------------------------------------- 文件加载

  private resolvePathFromState(state: unknown): string | null {
    if (!isPlain(state)) return null;
    const candidates: unknown[] = [state.file, state.path];
    const nested = state.state;
    if (isPlain(nested)) candidates.push(nested.file, nested.path);
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
    return null;
  }

  async loadPath(path: string): Promise<void> {
    const file = this.host.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      this.showBanner(`找不到文件：${path}`, "error");
      return;
    }
    await this.loadFile(file);
  }

  async loadFile(file: TFile): Promise<void> {
    this.file = file;
    this.menuNameEl?.setText(file.path);
    // 首次打开某个文件时提示一次「别多设备同时开」，之后不再打扰
    if (!this.warnedFiles.has(file.path)) {
      this.warnedFiles.add(file.path);
      new Notice(CONCURRENCY_NOTICE, 7000);
    }
    try {
      const text = await this.host.app.vault.read(file);
      const r = extractProgress(text);
      this.baselineUpdatedAt = getMetaUpdatedAt(r.data);
      this.host.log(
        `loadFile ${file.path} 进度区=${r.found ? "有" : "无"}${
          r.error ? ` 解析错误=${r.error}` : ""
        } 长度=${text.length}`,
      );
      if (!r.found) {
        this.showBanner(
          "这个文件里还没有进度数据区，保存时插件会自动创建。",
          "warn",
        );
      } else if (r.error) {
        this.showBanner(
          `进度数据区解析失败（${r.error}），保存时会被重建。`,
          "warn",
        );
      }
      this.currentHtml = text;
      this.applyHtmlToFrame(text);
      this.setStatus("就绪", "plain");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showBanner(`读取失败：${msg}`, "error");
    }
  }

  /**
   * 把 HTML 渲染进 iframe。
   *
   * 注入一枚一次性令牌：沙箱 iframe 可能运行在独立进程里，
   * `event.source === iframe.contentWindow` 不一定成立，
   * 因此消息校验以令牌为准，source 仅作辅助。
   *
   * 令牌脚本必须排在页面自身脚本 **之前**，否则页面读到的会是空令牌。
   */
  private applyHtmlToFrame(text: string): void {
    if (!this.iframeEl) return;
    // 换页：先按住保存，等新页面握手再放行（见 awaitingFreshPage）
    this.awaitingFreshPage = true;
    if (this.freshPageTimer !== null) window.clearTimeout(this.freshPageTimer);
    // 兜底：新页面万一握不上手（HTML 坏了），3 秒后放行，避免用户改的东西全丢
    this.freshPageTimer = window.setTimeout(() => {
      this.freshPageTimer = null;
      this.awaitingFreshPage = false;
    }, 3000);
    const snippet = `<script>window.__HVV_TOKEN__=${JSON.stringify(this.token)};</script>`;
    // 普通 HTML（用户从外面拿来的网页）没有 runtime，页面侧功能会一个都起不来。
    // 这里补注入一份；注入只发生在渲染时，磁盘上的原文件不受影响。
    const html = injectRuntime(text, RUNTIME_SOURCE);
    const bodyOpen = /<body\b[^>]*>/i.exec(html);
    if (bodyOpen && bodyOpen.index !== undefined) {
      const at = bodyOpen.index + bodyOpen[0].length;
      this.iframeEl.srcdoc = `${html.slice(0, at)}\n${snippet}${html.slice(at)}`;
    } else {
      const bodyRe = /<\/body\s*>/gi;
      let last = -1;
      let m: RegExpExecArray | null;
      while ((m = bodyRe.exec(html)) !== null) last = m.index;
      this.iframeEl.srcdoc =
        last >= 0
          ? `${html.slice(0, last)}${snippet}\n${html.slice(last)}`
          : `${html}\n${snippet}\n`;
    }
    this.host.log(`srcdoc 已设置，长度=${this.iframeEl.srcdoc.length}`);
  }

  async reloadFile(): Promise<void> {
    if (!this.file) {
      this.showBanner("当前没有打开任何 HTML 文件。", "warn");
      return;
    }
    this.pageReady = false;
    await this.loadFile(this.file);
  }

  // ---------------------------------------------------------------- 消息通道

  private handleMessage = (event: MessageEvent): void => {
    if (this.destroyed) return;
    const data: unknown = event.data;
    if (!isPlain(data)) return;
    const fromFrame = event.source === this.iframeEl?.contentWindow;
    const tokenOk = typeof data.token === "string" && data.token === this.token;
    // 只认自己这一枚令牌（或确实来自本 iframe）的消息
    if (!fromFrame && !tokenOk) {
      this.host.log(`丢弃陌生消息 type=${String(data.type)}`);
      return;
    }
    if (!isInboundMessage(data)) return;
    this.host.log(`收到消息 ${data.type}`);
    if (data.type === MSG_LOAD) {
      // 新页面握手完成：换页门控可以放行了
      this.awaitingFreshPage = false;
      if (this.freshPageTimer !== null) {
        window.clearTimeout(this.freshPageTimer);
        this.freshPageTimer = null;
      }
      void this.handleLoadRequest();
    } else if (data.type === MSG_SAVE) {
      if (this.awaitingFreshPage) {
        // 换页瞬间旧页面卸载时发出的残留保存：放行会把过期数据写回文件
        this.host.log("丢弃换页瞬间旧页面的残留保存");
        return;
      }
      void this.handleSaveRequest(data.payload);
    } else if (data.type === MSG_STATE) {
      this.host.log(`页面状态上报：${JSON.stringify(data.payload).slice(0, 1200)}`);
    } else if (data.type === MSG_INK) {
      this.host.log(`手写层状态：${JSON.stringify(data.payload).slice(0, 600)}`);
    }
  }

  /** 索要页面当前状态（用于验证状态恢复） */
  probeState(): void {
    this.probeRequested = true;
    this.host.log(`probeState 提交，pageReady=${this.pageReady}`);
    if (this.pageReady) {
      this.probeRequested = false;
      this.postToFrame({ type: MSG_PROBE });
    }
  };

  private postToFrame(message: unknown): void {
    const iframe = this.iframeEl;
    if (!iframe || !iframe.contentWindow) return;
    const payload = isPlain(message)
      ? { ...message, token: this.token }
      : message;
    try {
      // 沙箱 iframe 为不透明源，只能用 "*"
      iframe.contentWindow.postMessage(payload, "*");
    } catch (err) {
      this.host.log(`postMessage 失败：${String(err)}`);
    }
  }

  private async handleLoadRequest(): Promise<void> {
    const file = this.file;
    if (!file) {
      this.postToFrame({
        type: MSG_PROGRESS,
        payload: { payload: {}, pluginVersion: this.host.pluginVersion, source: "plugin" },
      });
      return;
    }
    try {
      const text = await this.host.app.vault.read(file);
      const r = extractProgress(text);
      this.baselineUpdatedAt = getMetaUpdatedAt(r.data);
      this.postToFrame({
        type: MSG_PROGRESS,
        payload: {
          payload: r.data ?? {},
          pluginVersion: this.host.pluginVersion,
          source: "plugin",
        },
      });
      this.pageReady = true;
      if (this.selftestPayload) {
        const req = this.selftestPayload;
        this.selftestPayload = null;
        window.setTimeout(() => {
          this.postToFrame({ type: MSG_SELFTEST, payload: req });
        }, 80);
      }
      if (this.probeRequested) {
        this.probeRequested = false;
        window.setTimeout(() => {
          this.postToFrame({ type: MSG_PROBE });
        }, 80);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToFrame({
        type: MSG_PROGRESS,
        payload: { payload: {}, pluginVersion: this.host.pluginVersion, source: "plugin" },
      });
      this.setStatus(`读取失败：${msg}`, "error");
    }
  }

  private async handleSaveRequest(rawPayload: unknown): Promise<void> {
    const file = this.file;
    if (!file) {
      this.postToFrame({ type: MSG_ACK, payload: { ok: false, error: "没有打开文件" } });
      return;
    }
    const clean = sanitizePayload(rawPayload);
    if (!clean.ok) {
      this.postToFrame({
        type: MSG_ACK,
        payload: { ok: false, error: clean.reason },
      });
      this.setStatus(`保存被拒绝：${clean.reason}`, "error");
      return;
    }

    try {
      const outcome = await this.lock.run(file.path, async () => {
        const diskText = await this.host.app.vault.read(file);
        const diskBlock = extractProgress(diskText).data ?? {};
        const diskUpdatedAt = getMetaUpdatedAt(diskBlock);
        const external = diskUpdatedAt !== this.baselineUpdatedAt;

        const incoming = clean.payload as Record<string, unknown>;
        const { merged, keptFromDisk } = mergeProgress(diskBlock, incoming);

        const meta = isPlain(merged.meta) ? merged.meta : {};
        merged.meta = {
          ...meta,
          schema: "html-quiz-progress/v1",
          updatedAt: new Date().toISOString(),
          updatedBy: this.deviceId,
        };

        const { text } = applyProgress(diskText, merged);
        this.selfWriteUntil = Date.now() + 1500;
        await this.host.app.vault.modify(file, text);
        this.baselineUpdatedAt = getMetaUpdatedAt(merged);
        this.host.log(
          `写回成功 ${file.path} external=${external} kept=${keptFromDisk.length}`,
        );
        return { external, kept: keptFromDisk.length };
      });

      this.postToFrame({
        type: MSG_ACK,
        payload: { ok: true, savedAt: new Date().toISOString() },
      });
      const clock = formatClock(new Date().toISOString());
      this.setStatus(
        outcome.external
          ? `已保存于 ${clock} · 已合并其他设备的修改`
          : `已保存于 ${clock}`,
        "ok",
      );
      this.setKept(outcome.kept);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postToFrame({ type: MSG_ACK, payload: { ok: false, error: msg } });
      this.setStatus(`保存失败：${msg}`, "error");
      new Notice(`保存失败：${msg}`);
    }
  }

  // ---------------------------------------------------------------- 外部改动

  notifyExternalChange(path: string): void {
    if (this.destroyed) return;
    if (!this.file || this.file.path !== path) return;
    if (Date.now() < this.selfWriteUntil) return;
    void (async () => {
      try {
        const text = await this.host.app.vault.read(this.file as TFile);
        const diskUpdatedAt = getMetaUpdatedAt(extractProgress(text).data);
        if (diskUpdatedAt === this.baselineUpdatedAt) return;
        this.setStatus("该文件已在别处被修改，点左侧 ‹ 可重新加载", "warn");
      } catch {
        /* ignore */
      }
    })();
  }

  // ---------------------------------------------------------------- 复习清单

  async copyReviewList(): Promise<string> {
    const file = this.file;
    if (!file) {
      new Notice("当前没有打开任何 HTML 文件。");
      return "";
    }
    const text = await this.host.app.vault.read(file);
    const progress = extractProgress(text).data ?? {};
    const meta = extractContentMeta(text).data ?? {};
    const md = buildReviewMarkdown(progress, meta, { sourceName: file.name });
    try {
      await navigator.clipboard.writeText(md);
      new Notice("复习清单已复制到剪贴板。");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`复制失败：${msg}`);
    }
    return md;
  }

  /** 清理墓碑条目 */
  async cleanTombstones(): Promise<void> {
    const file = this.file;
    if (!file) return;
    await this.lock.run(file.path, async () => {
      const text = await this.host.app.vault.read(file);
      const block = extractProgress(text).data;
      if (!block) return;
      const cleaned = stripTombstones(block);
      const { text: next } = applyProgress(text, cleaned);
      this.selfWriteUntil = Date.now() + 1500;
      await this.host.app.vault.modify(file, next);
      this.baselineUpdatedAt = getMetaUpdatedAt(cleaned);
    });
    new Notice("已清理已删除条目（墓碑）。");
  }

  // ---------------------------------------------------------------- 自检

  requestSelftest(req: SelftestRequest): void {
    this.selftestPayload = req;
    // 页面已就绪就直接发；否则等它握手（LOAD_PROGRESS）后再发，避免消息早于监听器丢失
    if (this.pageReady) {
      this.postToFrame({ type: MSG_SELFTEST, payload: req });
      this.selftestPayload = null;
    }
  }

  // ---------------------------------------------------------------- UI

  private setStatus(
    text: string,
    kind: "ok" | "error" | "warn" | "plain" = "plain",
  ): void {
    if (!this.savedEl) return;
    this.savedEl.setText(text);
    this.savedEl.toggleClass("is-ok", kind === "ok");
    this.savedEl.toggleClass("is-error", kind === "error");
    this.savedEl.toggleClass("is-warn", kind === "warn");
  }

  /** 「保留了对方修改 N 处」——合并冲突时才有 */
  private setKept(n: number): void {
    if (!this.keptEl) return;
    this.keptEl.setText(n > 0 ? `· 保留了对方修改 ${n} 处` : "");
  }

  /** 顶栏已并入底栏：普通提示走底栏，致命错误用 Notice */
  private showBanner(text: string, kind: "warn" | "error" = "warn"): void {
    if (kind === "error") {
      new Notice(text);
      this.setStatus(text, "error");
      return;
    }
    this.setStatus(text, "warn");
  }

  private toggleMenu(): void {
    if (!this.menuEl || !this.foldEl) return;
    const open = !this.menuEl.classList.contains("is-open");
    this.menuEl.classList.toggle("is-open", open);
    this.foldEl.classList.toggle("is-open", open);
    this.foldEl.textContent = open ? "›" : "‹";
  }

  private closeMenu(): void {
    if (!this.menuEl || !this.foldEl) return;
    if (!this.menuEl.classList.contains("is-open")) return;
    this.menuEl.classList.remove("is-open");
    this.foldEl.classList.remove("is-open");
    this.foldEl.textContent = "‹";
  }

  toggleHelp(): void {
    this.helpEl?.classList.toggle("is-hidden");
  }
}
