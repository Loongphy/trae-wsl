/**
 * 下发脚本的"载荷构造"—— 这里是唯一的事实来源。
 * 打进 extension.js 的内联代码（anchors.ts 的 REPL）必须与本文件的输出逐字一致，
 * test/patched-code.test.ts 会同时执行两者并比对，防止实现漂移。
 */

/** Windows CreateProcess 命令行上限 32767；base64 分块大小取 24000，留出命令前缀余量。 */
export const B64_CHUNK = 24000

/**
 * 原始 heredoc 写法 `cat > "t" << 'EOF'\n<content>\nEOF` 落到文件里的内容是 content + 一个换行。
 * 补丁必须保持同样的产物，否则 Trae 后续的 `wc -c` 与脚本自身的行尾语义会变。
 */
export function contentToBase64(content: string): string {
  return Buffer.from(`${content}\n`, "utf8").toString("base64")
}

/** 切成若干段，每段长度是 4 的倍数（保证 base64 边界对齐，可独立解码） */
export function splitBase64(b64: string, size: number = B64_CHUNK): string[] {
  if (size % 4 !== 0) throw new RangeError(`chunk size must be a multiple of 4, got ${size}`)
  const chunks: string[] = []
  for (let i = 0; i < b64.length; i += size) chunks.push(b64.slice(i, i + size))
  // 空内容也要真的建出文件，让下游 `test -s` 报出清晰错误
  if (chunks.length === 0) chunks.push("")
  return chunks
}

/**
 * 交给登录 shell 的那条命令串（单行、无换行、外层单引号）。
 * 单引号内只会出现 base64 字母表 + 由 JSON.stringify 生成的双引号路径
 * => bash / fish / dash 解析结果一致。
 */
export function writePayload(target: string, b64: string, append: boolean): string {
  return `'echo ${b64} | base64 -d ${append ? ">>" : ">"} ${JSON.stringify(target)}'`
}

/** 完整下发计划：每个元素是一次 `bash -c <payload>` 的参数 */
export function deployPlan(content: string, target: string, size: number = B64_CHUNK): string[] {
  return splitBase64(contentToBase64(content), size).map((c, i) => writePayload(target, c, i > 0))
}
