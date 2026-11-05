import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import { HtmlQuizView, VIEW_TYPE_HTML } from "./view.ts";
import type { HtmlViewHost, SelftestRequest } from "./view.ts";
import { isPlainObject } from "./protocol.ts";

export default class HtmlSingleFileViewPlugin
  extends Plugin
  implements HtmlViewHost
{
  private logLines: string[] = [];
  private debugEnabled = false;

  /**
   * 调试日志。默认关闭；开启后写入插件自己的 data.json（标准 Obsidian 插件机制，
   * 与 vault 内容无关，不影响「删 HTML 即无残留」）。
   */
  log(message: string): void {
    if (!this.debugEnabled) return;
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
    this.logLines.push(line);
    if (this.logLines.length > 400) {
      this.logLines.splice(0, this.logLines.length - 400);
    }
    void this.saveData({ enabled: true, log: this.logLines });
  }

  private setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
    if (enabled) {
      this.log("=== 调试日志已开启 ===");
      void this.saveData({ enabled: true, log: this.logLines });
    } else {
      void this.saveData({ enabled: false, log: [] });
      this.logLines = [];
    }
  }

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_HTML, (leaf) => new HtmlQuizView(leaf, this));

    // 让 .html 文件直接以本视图打开
    try {
      this.registerExtensions(["html"], VIEW_TYPE_HTML);
    } catch (err) {
      console.warn("[html-single-file-view] registerExtensions 失败", err);
    }

    this.addRibbonIcon("glasses", "用 HTML 视图打开当前文件", () => {
      void this.openActiveFileInView();
    });

    this.addCommand({
      id: "open-html-in-view",
      name: "用 HTML 视图打开当前文件",
      callback: () => {
        void this.openActiveFileInView();
      },
    });

    this.addCommand({
      id: "reload-html-view",
      name: "刷新当前 HTML 视图",
      callback: () => {
        void this.reloadActiveView();
      },
    });

    this.addCommand({
      id: "copy-review-list",
      name: "复制当前 HTML 的复习清单",
      callback: () => {
        void this.copyReviewListForActive();
      },
    });

    this.addCommand({
      id: "clean-tombstones",
      name: "清理 HTML 进度里的已删除条目",
      callback: () => {
        void this.cleanTombstonesForActive();
      },
    });

    this.addCommand({
      id: "toggle-html-help",
      name: "切换 HTML 视图使用说明",
      callback: () => {
        this.activeView()?.toggleHelp();
      },
    });

    this.addCommand({
      id: "dev-html-selftest",
      name: "（开发）向当前 HTML 视图注入自检",
      callback: () => {
        this.activeView()?.requestSelftest(this.defaultSelftest());
      },
    });

    // 文件右键菜单
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension.toLowerCase() !== "html") return;
        menu.addItem((item) =>
          item
            .setTitle("用 HTML 视图打开")
            .setIcon("glasses")
            .onClick(() => {
              void this.openFileInView(file);
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("用默认方式打开")
            .setIcon("external-link")
            .onClick(() => {
              this.openWithDefaultApp(file);
            }),
        );
      }),
    );

    // 视图空着时，跟随当前打开的 html 文件
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension.toLowerCase() !== "html") return;
        const empty = this.app.workspace
          .getLeavesOfType(VIEW_TYPE_HTML)
          .map((leaf) => leaf.view as HtmlQuizView)
          .find((view) => view instanceof HtmlQuizView && view.isEmpty());
        if (empty) void empty.loadFile(file);
      }),
    );

    // 外部改动检测
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML)) {
          const view = leaf.view as HtmlQuizView;
          if (view instanceof HtmlQuizView) view.notifyExternalChange(file.path);
        }
      }),
    );

    this.addCommand({
      id: "toggle-html-debug",
      name: "切换 HTML 视图调试日志",
      callback: () => {
        this.setDebug(!this.debugEnabled);
        new Notice(
          this.debugEnabled
            ? "调试日志已开启，写入插件目录的 data.json"
            : "调试日志已关闭",
        );
      },
    });

    // 无人值守入口：obsidian://html-view?do=selftest&file=...
    this.registerObsidianProtocolHandler("html-view", (params) => {
      void this.handleProtocol(params);
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_HTML);
  }

  get pluginVersion(): string {
    return this.manifest.version;
  }

  // ---------------------------------------------------------------- 内部工具

  private activeView(): HtmlQuizView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML).find(
      (l) => l.view instanceof HtmlQuizView,
    );
    return leaf ? (leaf.view as HtmlQuizView) : null;
  }

  private defaultSelftest(): SelftestRequest {
    return {
      answer: { q1: "B" },
      noteText: "自检笔记",
      annotationText: "自检批注",
      markText: "自检标记",
      scrollTo: 400,
    };
  }

  private async openActiveFileInView(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "html") {
      new Notice("当前活动文件不是 HTML。");
      return;
    }
    await this.openFileInView(file);
  }

  private async openFileInView(file: TFile): Promise<WorkspaceLeaf> {
    const existing = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_HTML)
      .find((l) => this.leafShowsFile(l, file.path));
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      // 存根叶子（重启后恢复的标签页）此时还没有视图实例，需要显式绑定文件
      const view = existing.view as HtmlQuizView | undefined;
      if (view instanceof HtmlQuizView && view.filePath !== file.path) {
        await view.loadPath(file.path);
      }
      return existing;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_HTML,
      state: { file: file.path },
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  /**
   * 判断某个标签页当前（或曾经）显示的是不是这个文件。
   *
   * 不能只看视图实例的 filePath：Obsidian 重启后恢复工作区时，
   * 尚未激活的标签页只有「存根」，视图实例还没创建，filePath 取不到。
   * 只看实例的话，每次打开都会新建一个标签页，标签越堆越多。
   */
  private leafShowsFile(leaf: WorkspaceLeaf, path: string): boolean {
    const view = leaf.view as HtmlQuizView | undefined;
    if (view instanceof HtmlQuizView && view.filePath) {
      return view.filePath === path;
    }
    const state = leaf.getViewState?.();
    const candidates: unknown[] = [];
    if (isPlainObject(state)) {
      candidates.push(state.path, state.file);
      const nested = state.state;
      if (isPlainObject(nested)) candidates.push(nested.path, nested.file);
    }
    return candidates.some((c) => typeof c === "string" && c === path);
  }

  private async reloadActiveView(): Promise<void> {
    await this.activeView()?.reloadFile();
  }

  private async copyReviewListForActive(): Promise<void> {
    await this.activeView()?.copyReviewList();
  }

  private async cleanTombstonesForActive(): Promise<void> {
    await this.activeView()?.cleanTombstones();
  }

  private openWithDefaultApp(file: TFile): void {
    const app = this.app as unknown as {
      openWithDefaultApp?: (path: string) => void;
    };
    if (typeof app.openWithDefaultApp === "function") {
      app.openWithDefaultApp(file.path);
      return;
    }
    new Notice(
      "当前环境不支持「用默认方式打开」，可以在文件管理器里用浏览器打开该文件。",
    );
  }

  private async handleProtocol(params: Record<string, string>): Promise<void> {
    // Obsidian 的 URI 只把 query 交给 handler：
    //   obsidian://html-view?do=selftest&file=xxx
    // 路径段（obsidian://html-view/selftest）不会进入 query，因此子动作走 do= 参数。
    const action = String(params.do ?? params.mode ?? "open");
    if (action === "debug") {
      const enable = params.enable !== "0";
      this.setDebug(enable);
      new Notice(enable ? "调试日志已开启" : "调试日志已关闭");
      return;
    }
    const rawPath = params.file ?? "";
    if (!rawPath) {
      new Notice("缺少 file 参数。");
      return;
    }
    const path = normalizePath(rawPath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${path}`);
      return;
    }
    if (action === "review") {
      const leaf = await this.openFileInView(file);
      await (leaf.view as HtmlQuizView).copyReviewList();
      return;
    }
    if (action === "clean") {
      const leaf = await this.openFileInView(file);
      await (leaf.view as HtmlQuizView).cleanTombstones();
      return;
    }
    const leaf = await this.openFileInView(file);
    const view = leaf.view as HtmlQuizView;
    if (action === "selftest" || action === "probe") {
      // 重新读文件并重建 iframe：确保页面是最新代码、且握手后才会收到后续指令
      await view.reloadFile();
    }
    if (action === "selftest") {
      view.requestSelftest(this.defaultSelftest());
    } else if (action === "probe") {
      view.probeState();
      this.log(`已向视图索要页面状态：${file.path}`);
    }
  }
}
