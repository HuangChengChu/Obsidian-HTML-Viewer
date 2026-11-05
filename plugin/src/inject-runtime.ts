/**
 * 给「没有 runtime 的普通 HTML」注入页面运行时。
 *
 * 为什么需要：
 * 翻页键、触屏分区翻页、标注、笔记、标记、手写、进度回写——全部由 runtime 提供，
 * 插件本体只负责外壳和消息通道。模板生成的 HTML 自带 runtime，
 * 但用户从外面拿来的普通网页没有，于是页面侧一个功能都起不来。
 *
 * 这里是纯函数（runtime 源码由调用方传入），便于单测。
 */

/** runtime 在页面里的标记：模板内置了它，注入前先看有没有 */
export const RUNTIME_MARK = "__HTML_VIEW__";

/** 这个 HTML 里是不是已经有 runtime 了 */
export function hasRuntime(html: string): boolean {
  return html.includes(RUNTIME_MARK);
}

/**
 * 把 runtime 注入到 `</body>` 前。
 *
 * - 已经自带 runtime 的原样返回（幂等，重复注入不会叠加）
 * - 没有 `</body>` 的（比如片段文件）就追加到末尾
 * - runtime 源码里不含 `</script`，可直接放进 `<script>` 标签
 */
export function injectRuntime(html: string, runtimeSource: string): string {
  if (hasRuntime(html)) return html;
  const snippet = `<script>\n${runtimeSource}\n</script>`;
  const at = html.lastIndexOf("</body>");
  if (at < 0) return `${html}\n${snippet}\n`;
  return `${html.slice(0, at)}${snippet}\n${html.slice(at)}`;
}
