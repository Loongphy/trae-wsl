import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { toWindowsPath } from "./paths.ts"

export const TOOL_DIR_NAME = "trae-wsl"
export const TOOL_FILE_NAME = "trae-wsl.mjs"
export const LAUNCHER_NAME = "trae-wsl-launcher.cmd"

/** 当前正在执行的本工具文件（产物是单个自包含 .mjs，复制给 launcher 用） */
export function currentSelfFile(metaUrl?: string): string {
  let raw = ""
  if (metaUrl?.startsWith("file:")) {
    try {
      raw = fileURLToPath(metaUrl)
    } catch {
      raw = metaUrl.replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/i, "$1:")
    }
  }
  return toWindowsPath(raw || process.argv[1] || "")
}

export function defaultToolDir(winEnv: NodeJS.ProcessEnv = process.env): string {
  const local = winEnv.LOCALAPPDATA || path.join(winEnv.USERPROFILE || "C:\\", "AppData", "Local")
  return path.join(local, TOOL_DIR_NAME)
}

export function launcherContent(opts: { toolFileWin: string; traeExeWin: string }): string {
  return [
    "@echo off",
    "rem trae-wsl-launcher.cmd — 由 trae-wsl install-launcher 生成",
    "rem 启动 Trae 前自愈式补 WSL 补丁（Trae 更新覆盖 extension.js 后会自动重打）",
    "setlocal enableextensions",
    'set "LOG=%~dp0launcher.log"',
    `set "TOOL=${opts.toolFileWin}"`,
    'set "NODEEXE=%ProgramFiles%\\nodejs\\node.exe"',
    'if not exist "%NODEEXE%" where node >nul 2>&1 && set "NODEEXE=node"',
    `set "TRAEEXE=${opts.traeExeWin}"`,
    'if not exist "%TRAEEXE%" (',
    "  echo [trae-wsl-launcher] 找不到 Trae，请编辑本文件的 TRAEEXE",
    "  pause & exit /b 1",
    ")",
    'echo ===== %DATE% %TIME% =====>> "%LOG%" 2>&1',
    'if exist "%NODEEXE%" (',
    '  "%NODEEXE%" "%TOOL%" if-stale >> "%LOG%" 2>&1',
    "  if errorlevel 3 echo [trae-wsl-launcher] 锚点漂移：需要更新工具（详见 %LOG%）",
    ") else (",
    "  echo [trae-wsl-launcher] 没找到 node，跳过补丁检查：WSL 连接会退回 exit 127",
    ")",
    'start "" "%TRAEEXE%" %*',
    "endlocal",
    "",
  ].join("\r\n")
}

/**
 * 从安装根目录推主程序：<root>\<目录名>.exe 优先，否则取第一个非卸载器/非 helper 的 .exe。
 * 不维护产品名单；推不出来就抛错，不猜路径。
 */
export function traeExeIn(appRoot: string): string | undefined {
  const want = path.join(appRoot, `${path.basename(appRoot)}.exe`)
  if (fs.existsSync(want)) return want
  const noise = /^(?:unins|uninstall|squirrel|.*[-_. ]helper.*|.*crash.*|.*updater.*|.*elevate.*)/i
  for (const f of exesIn(appRoot)) {
    if (!noise.test(f.replace(/\.exe$/i, ""))) return path.join(appRoot, f)
  }
  return undefined
}

function exesIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".exe"))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export interface InstallResult {
  dir: string
  toolFile: string
  launcherPath: string
  traeExe: string
}

/** 把工具单文件 + 启动器写到 %LOCALAPPDATA%（刻意不放进 Trae 安装目录：更新会整体替换） */
export function installLauncher(opts: {
  dir?: string
  selfFile: string
  traeExe?: string
  candidates?: { appRoot: string }[]
}): InstallResult {
  const dir = opts.dir ? toWindowsPath(opts.dir) : defaultToolDir()
  fs.mkdirSync(dir, { recursive: true })
  const toolFile = path.join(dir, TOOL_FILE_NAME)
  fs.copyFileSync(toWindowsPath(opts.selfFile), toolFile)
  let traeExe = opts.traeExe ? toWindowsPath(opts.traeExe) : undefined
  for (const c of opts.candidates ?? []) {
    traeExe = traeExeIn(c.appRoot)
    if (traeExe) break
  }
  if (!traeExe) throw new Error("没能确定 Trae 可执行文件，请用 --trae-exe <路径> 指定")
  const launcherPath = path.join(dir, LAUNCHER_NAME)
  fs.writeFileSync(launcherPath, launcherContent({ toolFileWin: toolFile, traeExeWin: traeExe }), "utf8")
  return { dir, toolFile, launcherPath, traeExe }
}
