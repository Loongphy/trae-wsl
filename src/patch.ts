import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { applyToSource, detectState, driftContext, MARKER, type PatchState } from "./anchors.ts"

/** 原始 bundle 的备份就叫这个名（就放在 bundle 旁边） */
export const BACKUP_SUFFIX = ".trae-wsl.bak"
export function backupPathOf(nativePath: string): string {
  return `${nativePath}${BACKUP_SUFFIX}`
}

export interface TargetStatus {
  nativePath: string
  state: PatchState
  bytes: number
  sha1: string
  backup?: string
  error?: string
}

export interface PatchResult {
  nativePath: string
  ok: boolean
  changed: boolean
  state: PatchState
  reason: string
  backup?: string
  error?: string
}

export function statusOf(nativePath: string): TargetStatus {
  try {
    const src = fs.readFileSync(nativePath, "utf8")
    return {
      nativePath,
      state: detectState(src),
      bytes: Buffer.byteLength(src),
      sha1: crypto.createHash("sha1").update(src).digest("hex").slice(0, 12),
      backup: existingBackup(nativePath),
    }
  } catch (e) {
    return {
      nativePath,
      state: "no-site",
      bytes: 0,
      sha1: "-",
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** bundle 旁边那份（未修改的）原始文件，存在则返回其路径 */
function existingBackup(nativePath: string): string | undefined {
  const p = backupPathOf(nativePath)
  return fs.existsSync(p) ? p : undefined
}

function describe(state: PatchState): string {
  switch (state) {
    case "patched":
      return "已打补丁"
    case "pristine":
      return "未打补丁，可直接打"
    case "drift-anchor":
      return "锚点漂移：有 heredoc 但代码形状变了"
    case "no-site":
      return "这个版本没有 heredoc 下发写法，无需补丁"
  }
}

export function applyPatch(nativePath: string, opts: { force?: boolean } = {}): PatchResult {
  let src: string
  try {
    src = fs.readFileSync(nativePath, "utf8")
  } catch (e) {
    return { nativePath, ok: false, changed: false, state: "no-site", reason: "读取失败", error: msg(e) }
  }
  const before = detectState(src)

  if (opts.force && before === "patched") {
    const bak = existingBackup(nativePath)
    if (!bak)
      return {
        nativePath,
        ok: false,
        changed: false,
        state: before,
        reason: "--force 需要原始备份才能重打，但没找到备份；不做破坏性操作",
      }
    src = fs.readFileSync(bak, "utf8")
  }

  if (!opts.force && (before === "patched" || before === "no-site")) {
    return { nativePath, ok: true, changed: false, state: before, reason: describe(before), backup: existingBackup(nativePath) }
  }

  const res = applyToSource(src)
  if (!res.ok) {
    return {
      nativePath,
      ok: false,
      changed: false,
      state: res.state,
      reason: `${res.reason}\n${driftContext(src)[0] ?? ""}`.slice(0, 4000),
    }
  }
  if (res.out === src) {
    return { nativePath, ok: true, changed: false, state: res.state, reason: res.reason ?? describe(res.state) }
  }

  const backup = backupPathOf(nativePath)
  try {
    // 已有备份就不重写：备份的意义就是能回到未修改的原始文件，覆盖一次就永久失去它
    if (!existingBackup(nativePath)) fs.writeFileSync(backup, src)
  } catch (e) {
    return { nativePath, ok: false, changed: false, state: res.state, reason: "备份写入失败", error: msg(e) }
  }

  try {
    fs.writeFileSync(nativePath, res.out)
  } catch (e) {
    return {
      nativePath,
      ok: false,
      changed: false,
      state: res.state,
      reason: "写入失败：Trae 可能仍在运行占用该文件。请完全退出 Trae（含托盘/后台进程）后重试；本工具不会替你杀进程。",
      error: msg(e),
    }
  }
  return {
    nativePath,
    ok: true,
    changed: true,
    state: "patched",
    reason: `已打补丁 ${MARKER}`,
    backup: existingBackup(nativePath),
  }
}

export function restore(nativePath: string): PatchResult {
  const bak = existingBackup(nativePath)
  if (!bak)
    return {
      nativePath,
      ok: true,
      changed: false,
      state: detectStateSafe(nativePath),
      reason: "没有备份文件，未做任何修改",
    }
  try {
    fs.copyFileSync(bak, nativePath)
  } catch (e) {
    return { nativePath, ok: false, changed: false, state: "no-site", reason: "还原失败（Trae 可能在运行）", error: msg(e) }
  }
  return {
    nativePath,
    ok: true,
    changed: true,
    state: detectStateSafe(nativePath),
    reason: `已从 ${path.basename(bak)} 还原`,
    backup: bak,
  }
}

function detectStateSafe(nativePath: string): PatchState {
  try {
    return detectState(fs.readFileSync(nativePath, "utf8"))
  } catch {
    return "no-site"
  }
}

function msg(e: unknown): string {
  if (e instanceof Error) return `${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}`.trim()
  return String(e)
}

export { describe as describeState }
