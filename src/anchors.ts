import { B64_CHUNK } from "./payloads.ts"

/** 本工具打的补丁标记（写进 bundle，用于幂等判断与版本识别） */
export const MARKER = "/*trae-wsl-patch:v1*/"

/**
 * bundle 里原始写法的精确字节。
 * 注意：模板串里的 `\n` 在磁盘上是「反斜杠 + n」两个字符，所以这里写成 `\\n`。
 */
export const ANCHOR =
  'const i=`cat > "${t}" << \'EOF\'\\n${e}\\nEOF`,o=await n.wslManager.exec("bash",["-c",i],n.distroName),{exitCode:s}=await o.exitPromise;if(0!==s)throw new Error(`Failed to write script file with exit code: ${s}`);'

/**
 * 替换后的内联代码。分块大小由 B64_CHUNK 单一来源注入；载荷构造与 src/payloads.ts 的
 * `writePayload()` 逐字一致（test/patched-code.test.ts 会双向比对）。
 *
 * 变量名以 `_` 前缀避开同函数后文里已经存在的 `r/a/c/l/s/o/i/e`，
 * 这是 minified bundle 里最容易踩的坑（撞名会把后面的校验逻辑改废）。
 */
/**
 * 内联代码的生成器：分块大小是参数，默认用生产值 B64_CHUNK。
 * selftest 用小分块测“分块数学 + > / >> 顺序”；argv 长度不由某个本机 shell 的实现
 * 决定（msys Git-bash 会在长 argv 上截断），而是由不依赖 shell 的断言与真机 verify 覆盖。
 */
export function makeRepl(chunkSize: number = B64_CHUNK): string {
  if (chunkSize % 4 !== 0) throw new RangeError(`chunk size must be a multiple of 4, got ${chunkSize}`)
  return (
    MARKER +
    'const _b=Buffer.from(e+"\\n","utf8").toString("base64"),_c=[];for(let _q=0;_q<_b.length;_q+=' +
    chunkSize +
    ')_c.push(_b.slice(_q,_q+' +
    chunkSize +
    '));if(!_c.length)_c.push("");let _x,_ec=0;for(let _q=0;_q<_c.length;_q++){const _p="\'echo "+_c[_q]+" | base64 -d "+(_q?">>":">")+" "+JSON.stringify(t)+"\'";_x=await n.wslManager.exec("bash",["-c",_p],n.distroName),_ec=(await _x.exitPromise).exitCode;if(0!==_ec)throw new Error(`Failed to write script file with exit code: ${_ec} (b64 chunk ${_q+1}/${_c.length})`)}'
  )
}

/** 打进 bundle 的最终替换串 */
export const REPL = makeRepl()

/** 上游下发脚本的写法特征（用于报告，不作为主判据） */
export const HEREDOC_SIGNATURE = "<< 'EOF'"

/** 被补的目标函数签名 —— 它还在而锚点找不到，就说明上游改了写法 */
export const DEPLOY_FN_SIGNATURE = "async deployScriptToWSL(e,t,n){"

export type PatchState = "pristine" | "patched" | "drift-anchor" | "no-site"

export function detectState(src: string): PatchState {
  if (src.includes(MARKER)) return "patched"
  const hits = src.split(ANCHOR).length - 1
  if (hits === 1) return "pristine"
  if (hits > 1) return "drift-anchor" // 不该出现：锚点重复意味着锚点太弱
  if (src.includes(DEPLOY_FN_SIGNATURE)) return "drift-anchor" // 函数还在、锚点没了 = 上游改了写法
  if (src.includes(HEREDOC_SIGNATURE)) return "drift-anchor"
  return "no-site"
}

/** 锚点漂移时给人看的上下文（拿去更新 ANCHOR 用） */
export function driftContext(src: string, radius = 260): string[] {
  const out: string[] = []
  for (const needle of [HEREDOC_SIGNATURE, DEPLOY_FN_SIGNATURE]) {
    let i = 0
    while (true) {
      i = src.indexOf(needle, i)
      if (i < 0) break
      out.push(src.slice(Math.max(0, i - radius), i + radius))
      i += needle.length
      if (out.length >= 4) return out
    }
  }
  return out
}

export function applyToSource(
  src: string,
  opts: { chunkSize?: number } = {},
): { ok: boolean; out: string; state: PatchState; reason?: string } {
  const state = detectState(src)
  if (state === "patched") return { ok: true, out: src, state, reason: "已是补丁版" }
  if (state === "no-site") return { ok: true, out: src, state, reason: "这个版本没有 heredoc 下发写法，无需补丁" }
  if (state === "drift-anchor")
    return { ok: false, out: src, state, reason: "检测到 heredoc 但锚点不匹配：Trae 改了代码形状，拒绝猜测修改" }
  return { ok: true, out: src.replace(ANCHOR, makeRepl(opts.chunkSize ?? B64_CHUNK)), state }
}
