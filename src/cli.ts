#!/usr/bin/env node
import process from "node:process"
import { discover } from "./discover.ts"
import { applyPatch, restore, statusOf, type TargetStatus } from "./patch.ts"
import { currentSelfFile, installLauncher } from "./launcher.ts"
import { MARKER } from "./anchors.ts"
import { TOOL_DIR_NAME } from "./launcher.ts"

const USAGE = `trae-wsl — 修 Trae CN 连 WSL 失败（Linux 默认 shell 是 fish 时）

命令
  status            只读：每个候选 bundle 的状态（--json 机器可读）
  patch             打补丁（备份写在 bundle 旁边，只写一次）
  restore           从备份还原
  if-stale          launcher 用：未打才打，静默；退出码 0 成功 / 3 锚点漂移
  install-launcher  把工具单文件 + 自愈启动器写到 %LOCALAPPDATA%\\${TOOL_DIR_NAME}
  explain           根因与被否掉的方案（贴给上游 issue 用）

选项  --target <path>  指定 extension.js（C:\\… 或 /mnt/c/… 都吃）
      --force          从备份还原后重打
      --dir/--trae-exe install-launcher 的落点与 Trae 可执行文件
`

function parse(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const first = argv[0] ?? ""
  const cmd = first !== "" && !first.startsWith("-") ? first : "help"
  const flags: Record<string, string | boolean> = {}
  const rest = cmd === first ? argv.slice(1) : argv
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a?.startsWith("--")) continue
    const key = a.slice(2)
    const eq = key.indexOf("=")
    if (eq > 0) flags[key.slice(0, eq)] = key.slice(eq + 1)
    else {
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next
        i++
      } else flags[key] = true
    }
  }
  return { cmd, flags }
}

function targets(flags: Record<string, string | boolean>) {
  const t = typeof flags.target === "string" ? flags.target : undefined
  return discover(t ? { target: t } : {})
}

function row(s: TargetStatus): string {
  const mark = s.state === "patched" ? "✅" : s.state === "pristine" ? "🔧" : s.state === "drift-anchor" ? "⚠" : "·"
  return `${mark} ${s.nativePath}\n   状态: ${s.state}  字节: ${s.bytes}  sha1: ${s.sha1}${s.backup ? `\n   备份: ${s.backup}` : ""}${s.error ? `\n   错误: ${s.error}` : ""}`
}

function main(): number {
  const { cmd, flags } = parse(process.argv.slice(2))
  if (cmd === "help" || flags.help) return console.log(USAGE), 0
  if (cmd === "version" || flags.version) return console.log("@TRAE_WSL_PATCH_VERSION@"), 0
  if (cmd === "explain") return console.log(EXPLAIN), 0

  const list = targets(flags)
  if (!list.length) return console.error("没找到任何内置扩展的 extension.js；用 --target 指定"), 2

  switch (cmd) {
    case "status": {
      const rows = list.map((c) => statusOf(c.nativePath))
      if (flags.json) console.log(JSON.stringify(rows, null, 2))
      else rows.forEach((s) => console.log(row(s)))
      return rows.some((r) => r.state === "drift-anchor") ? 3 : 0
    }
    case "patch":
    case "if-stale": {
      const quiet = cmd === "if-stale"
      let worst = 0
      for (const c of list) {
        const r = applyPatch(c.nativePath, { force: !!flags.force })
        if (!quiet) console.log(`${r.ok ? "✅" : "❌"} ${c.nativePath}\n   ${r.changed ? "已打补丁" : r.reason.split("\n")[0]}${r.error ? `\n   ${r.error}` : ""}`)
        else if (!r.ok) console.error(`[${cmd}] ${r.reason.split("\n")[0]}`)
        if (!r.ok) worst = r.state === "drift-anchor" ? 3 : 1
      }
      return worst
    }
    case "restore": {
      for (const c of list) {
        const r = restore(c.nativePath)
        console.log(`${r.ok ? "✅" : "❌"} ${c.nativePath}\n   ${r.reason}${r.error ? ` ${r.error}` : ""}`)
        if (!r.ok) return 1
      }
      return 0
    }
    case "install-launcher": {
      const res = installLauncher({
        dir: typeof flags.dir === "string" ? flags.dir : undefined,
        selfFile: currentSelfFile(import.meta.url),
        traeExe: typeof flags["trae-exe"] === "string" ? flags["trae-exe"] : undefined,
        candidates: list,
      })
      console.log(
        `工具单文件 : ${res.toolFile}\n启动器     : ${res.launcherPath}\nTrae       : ${res.traeExe}\n\n下一步：把 Trae 快捷方式的「目标」改成\n  "${res.launcherPath}"`,
      )
      return 0
    }
    default:
      return console.error(`未知命令: ${cmd}\n\n${USAGE}`), 2
  }
}

const EXPLAIN = `根因（三点叠加，全部实测）
 1. exec() 走 \`wsl --distribution D -- bash -c <载荷>\`（不是 --exec），WSL 把命令尾巴原样交给
    「默认登录 shell」：<shell> -c "<raw tail>"。所以存在两层 shell，出错的是外层。
 2. spawn 带 windowsVerbatimArguments: true => 参数不加引号 => -c 的 operand 被截成一个词，
    heredoc 与重定向全由【外层】消化：
      bash -c cat > "/tmp/trae_script_x.sh" << 'EOF' … EOF
    bash 当外层时歪打正着能产出正确文件（内层只跑了 cat）；fish 没有 heredoc，解析期就死 =>
    exit 127 => Step install_wsl_server failed => resolveAuthority(wsl) TemporarilyNotAvailable。
 3. 修法：把那一处换成单行、外层单引号、引号内只有 base64 的命令
      bash -c 'echo <B64> | base64 -d > "<t>"'      （>18 KB 分块：先 > 后 >>）
    外层 shell 无事可解，只能整串交给内层 bash => 与"外层是什么 shell"彻底解耦；
    产物逐字节等价（含结尾换行），并顺带去掉 40 KB 级 heredoc 的 spawn ENAMETOOLONG。

被否掉的方案
  * 改用 --exec + 关闭 verbatim：Trae 后续把带 $HOME 的路径直接当参数传给 test/wc/mkdir
    （日志："Checking installation directory: $HOME/.trae-cn-server/…"），--exec 下没人展开 => 换个 bug。
  * 装第三方扩展：resolver 在内置扩展里（onResolveRemoteAuthority:wsl + enabledApiProposals:["resolvers"]），
    proposed API 用户扩展拿不到，也无法顶替已占用的 wsl authority。
  * 改默认登录 shell（加层路由）：作用域是整机，为一个 IDE 的 bug 动用户全局 shell 不合适。

marker: ${MARKER}`

// 退出码显式设置，不用 top-level await
process.exitCode = main()
