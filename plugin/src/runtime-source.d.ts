/**
 * runtime 源码以**文本**形式打包进插件（见 esbuild.config.mjs 的 runtime-text 插件）。
 *
 * 单一真源：templates/src/runtime.js。模板构建和插件注入读的是同一份。
 */
declare module "runtime-source" {
  const source: string;
  export default source;
}
