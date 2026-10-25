import fs from "node:fs"
import process from "node:process"

/** Windows 绝对路径（`C:\x` 或 `C:/x`） */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

/** 取正则的前两个捕获组，元组类型保证下游拿到的是 string */
function two(m: RegExpExecArray | null): [string, string] | undefined {
  const a = m?.[1]
  const b = m?.[2]
  return a === undefined || b === undefined ? undefined : [a, b]
}

/** 在 WSL 里读 Windows 文件常用 `/mnt/c/...`；在 Windows 里是 `C:\...`。两种都接受。 */
export function winToLinux(p: string): string {
  const g = two(/^([A-Za-z]):[\\/](.*)$/.exec(p))
  if (!g) return p
  return `/mnt/${g[0].toLowerCase()}/${g[1].replace(/\\/g, "/")}`
}

export function linuxToWin(p: string): string {
  const g = two(/^\/mnt\/([a-z])\/(.*)$/.exec(p))
  if (!g) return p
  return `${g[0].toUpperCase()}:\\${g[1].replace(/\//g, "\\")}`
}

/** 把用户给的路径转成"当前进程能直接 open 的那种" */
export function toNativePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return isWindowsPath(p) ? p : linuxToWin(p)
  return isWindowsPath(p) ? winToLinux(p) : p
}

/** 反过来：转成 Windows 侧（wsl.exe 兄弟进程 / .cmd 文件）能用的路径 */
export function toWindowsPath(p: string): string {
  return isWindowsPath(p) ? p : linuxToWin(p)
}

export function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
