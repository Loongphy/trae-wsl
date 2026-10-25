import fs from "node:fs"
import path from "node:path"

// dist/cli.mjs 必须是"复制到任意目录都能跑的单文件"：
//   1) 带 shebang（当 bin 用）
//   2) 只 import node: 内置模块，无同目录 chunk（install-launcher 就是复制这一个文件）
//   3) 版本号已烧进去（复制出去后旁边没有 package.json 可查）
// 任何一条不满足就让构建失败 —— 这几条就是这个包存在的理由。
const SHEBANG = "#!/usr/bin/env node\n"
const file = path.join("dist", "cli.mjs")
const problems = []

if (!fs.existsSync(file)) problems.push("缺少 dist/cli.mjs")
else {
  let src = fs.readFileSync(file, "utf8")
  if (!src.startsWith("#!")) src = SHEBANG + src
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "")
  const nonBuiltin = specs.filter((s) => !s.startsWith("node:"))
  if (nonBuiltin.length) problems.push(`非内置依赖，产物不自包含：${nonBuiltin.join(", ")}`)
  if (/from\s*["']\.\/|require\(\s*["']\.\/|import\(\s*["']\.\/|__dirname/.test(src)) problems.push("产物里有相对路径依赖或 __dirname 残留 chunk 迹象")
  const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version
  const baked = src.replace(/"@TRAE_WSL_PATCH_VERSION@"/g, JSON.stringify(version))
  if (baked === src) problems.push('找不到字符串哨兵 "@TRAE_WSL_PATCH_VERSION@"（cli.ts 里的版本号字面量被改掉了？）')
  else src = baked
  fs.writeFileSync(file, src)
  fs.chmodSync(file, 0o755)
}

if (problems.length) {
  console.error("postbuild FAILED:\n  " + problems.join("\n  "))
  process.exit(1)
}
console.log("postbuild ok:", fs.readdirSync("dist").map((f) => `${f}:${fs.statSync(path.join("dist", f)).size}B`).join(" "))
