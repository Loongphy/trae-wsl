import path from "node:path"
import process from "node:process"
import { isFile, safeReaddir, toNativePath } from "./paths.ts"

/**
 * 目标文件的固定身份：内置扩展 cloudide.icube-remote-ssh 的 bundle 相对路径。
 * 发现逻辑只认这个身份，不认安装目录叫什么名字 —— 于是产品改名/多产品共存/
 * 我装了几个 VS Code 系应用，都不需要在这里维护名单。
 */
export const EXT_REL = path.join(
  "resources",
  "app",
  "extensions",
  "cloudide.icube-remote-ssh",
  "out",
  "extension.js",
)

/** extension.js 往上走到产品安装根所需的层数：直接由 EXT_REL 自己推，不写魔数 */
export const APP_ROOT_DEPTH = EXT_REL.split(path.sep).length

export interface Candidate {
  /** 当前进程能直接 open 的路径（Windows 上是 C:\...，WSL 上可能是 /mnt/c/...） */
  nativePath: string
  /** 产品安装根目录 */
  appRoot: string
  /** 安装根目录的目录名，仅用于展示 */
  app: string
  /** 用户名，仅用于展示 */
  user: string
}

function usersRoot(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") {
    const drive = process.env.SystemDrive || "C:"
    return path.join(`${drive}\\`, "Users")
  }
  for (const cand of ["/mnt/c/Users", "/mnt/C/Users"]) if (safeReaddir(cand).length) return cand
  return undefined
}

export function appRootOf(nativePath: string): string {
  return path.resolve(nativePath, ...Array.from({ length: APP_ROOT_DEPTH }, () => ".."))
}

/** 找到所有装了该内置扩展的 bundle */
export function discover(
  opts: { target?: string; platform?: NodeJS.Platform; usersRoot?: string } = {},
): Candidate[] {
  const platform = opts.platform ?? process.platform
  if (opts.target) {
    const nativePath = toNativePath(opts.target, platform)
    return [{ nativePath, appRoot: appRootOf(nativePath), app: "(--target)", user: "(--target)" }]
  }
  const root = opts.usersRoot ?? usersRoot(platform)
  if (!root) return []
  const out: Candidate[] = []
  for (const user of safeReaddir(root)) {
    const programs = path.join(root, user, "AppData", "Local", "Programs")
    for (const appDir of safeReaddir(programs)) {
      const p = path.join(programs, appDir, EXT_REL)
      if (isFile(p)) out.push({ nativePath: p, appRoot: path.join(programs, appDir), app: appDir, user })
    }
  }
  return out
}
