import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ANCHOR, applyToSource, detectState, driftContext, MARKER, makeRepl, REPL } from "../src/anchors.ts"
import { B64_CHUNK, contentToBase64, deployPlan, splitBase64, writePayload } from "../src/payloads.ts"
import { applyPatch, backupPathOf, restore, statusOf } from "../src/patch.ts"
import { discover, EXT_REL, appRootOf } from "../src/discover.ts"
import { launcherContent, defaultToolDir, traeExeIn } from "../src/launcher.ts"

/** 形状与线上 bundle 一致的夹具：同样的前文、同样的锚点、同样的后文变量名（r/a/c/l） */
const PRISTINE =
  'async deployScriptToWSL(e,t,n){if(!n.wslManager)throw new Error("WSL Manager not available");try{' +
  ANCHOR +
  'const r=await n.wslManager.exec("test",["-s",t],n.distroName),{exitCode:a}=await r.exitPromise;if(0!==a)throw new Error("empty");const c=await n.wslManager.exec("wc",["-c",t],n.distroName),{exitCode:l}=await c.exitPromise;if(0===l){const e=c.stdout.match(/^\\s*(\\d+)/),i=e?parseInt(e[1],10):0;n.context?.logger?.info(`${i} bytes`)}}catch(e){throw new Error(`deploy failed: ${e instanceof Error?e.message:String(e)}`)}}' +
  'async executeStartupScript(){throw new Error("deprecated")}'

// ── 补丁定义 ────────────────────────────────────────────────────────────────
test("锚点匹配线上形状；打完有 marker、无 heredoc、幂等", () => {
  assert.equal(detectState(PRISTINE), "pristine")
  const once = applyToSource(PRISTINE)
  assert.ok(once.ok && once.out !== PRISTINE)
  assert.equal(detectState(once.out), "patched")
  assert.equal(once.out.split(MARKER).length - 1, 1)
  assert.ok(!once.out.includes("<< 'EOF'"))
  assert.equal(applyToSource(once.out).out, once.out)
})

test("上游改形状就拒绝修改（宁可不改，也不猜），并给出可贴回的上下文", () => {
  const tick = String.fromCharCode(96)
  const bs = String.fromCharCode(92)
  const D = "$"
  const mutated = PRISTINE.replace(
    ANCHOR,
    "const i=" + tick + 'cat > "' + D + '{t}" << ' + tick + "EOL" + bs + "n" + D + "{e}" + bs + "nEOL" + tick + ";await 0;",
  )
  assert.equal(detectState(mutated), "drift-anchor")
  assert.equal(applyToSource(mutated).ok, false)
  assert.ok(driftContext(mutated).some((c) => c.includes("EOL")))
  // 函数整个没了 => no-site，不算错误
  const removed = PRISTINE.replace(/async deployScriptToWSL[\s\S]*?async executeStartupScript/, "async other(){}")
  assert.equal(detectState(removed), "no-site")
  assert.ok(applyToSource(removed).ok)
})

test("内联代码不得抢占后文变量名（minified bundle 的经典坑）", () => {
  assert.ok(/const r=await/.test(PRISTINE) && /exitCode:a/.test(PRISTINE) && /const c=await/.test(PRISTINE))
  for (const name of [...REPL.matchAll(/(?:const|let|var)\s+(_?[A-Za-z][\w$]*)/g)].map((m) => m[1] ?? "")) {
    assert.ok(name.startsWith("_"), `内联代码声明了 ${name}，可能与后文撞名`)
  }
  assert.ok(makeRepl(1024).includes("_q+=1024") && makeRepl().includes(`_q+=${B64_CHUNK}`))
  assert.throws(() => makeRepl(5), RangeError)
})

// ── 载荷：形状与上限 ─────────────────────────────────────────────────────────
test("载荷单行、外层单引号、引号内只有 base64 + JSON 路径", () => {
  const weird = "#!/bin/bash\necho 'sq' \"dq\" $HOME `id` a && b ; # \\"
  for (const p of deployPlan(weird, '/tmp/has "space".sh')) {
    assert.ok(!p.includes("\n"))
    assert.ok(p.startsWith("'") && p.endsWith("'"))
    const inner = p.slice(1, -1)
    assert.ok(!inner.includes("'"))
    assert.equal(Buffer.from(/echo (\S+) \|/.exec(inner)?.[1] ?? "", "base64").toString("utf8"), `${weird}\n`)
  }
  // $HOME 留在单引号内 => 由内层 bash 展开，外层 shell 认不认识 $ 都无所谓
  assert.ok(writePayload("$HOME/x", "QQ==", false).includes(`"$HOME/x"`))
})

test("分块：边界是 4 的倍数、拼接可还原；生产分块下载荷远低于 32767", () => {
  const parts = splitBase64(contentToBase64("x".repeat(B64_CHUNK * 2 + 999)))
  assert.ok(parts.length >= 3 && parts.every((p) => p.length % 4 === 0))
  assert.equal(parts.join(""), contentToBase64("x".repeat(B64_CHUNK * 2 + 999)))
  const worst = `bash -c ${writePayload("/tmp/trae_index_startup_0123456789abcdef0123.sh", parts[0] ?? "", false)}`
  assert.ok(worst.length < 32767, `载荷过长: ${worst.length}`)
  assert.equal(deployPlan("", "/tmp/x").length, 1, "空内容也要建出文件")
})

test("内联代码真跑：生成的命令交给 bash 执行，落盘字节与期望一致", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-wsl-test-"))
  const src = applyToSource(PRISTINE).out
  const body = src.slice(src.indexOf("async deployScriptToWSL"), src.indexOf("async executeStartupScript")).replace(/\s+$/, "")
  for (const [i, content] of ["#!/bin/bash\necho hi", "#!/bin/bash\n" + "x".repeat(9000)].entries()) {
    const fn = new Function(`"use strict";return {${body}}`)().deployScriptToWSL as (c: string, t: string, ctx: unknown) => Promise<void>
    const cmds: string[][] = []
    const ctx = {
      distroName: "test",
      context: { logger: { info() {} } },
      wslManager: {
        exec: (c: string, args: string[]) => {
          cmds.push([c, ...args])
          return { exitPromise: Promise.resolve({ exitCode: 0 }), stdout: "42 /tmp/x", stderr: "" }
        },
      },
    }
    const target = `./case${i}.sh`
    await fn(content, target, ctx)
    // 与 WSL 的派发一致：外层 shell 收到 -c "<bash -c 载荷>"；cwd 让相对路径可预期
    for (const [, , payload] of cmds.filter(([c, flag]) => c === "bash" && flag === "-c")) {
      execFileSync("bash", ["-c", `bash -c ${payload}`], { cwd: dir })
    }
    const got = fs.readFileSync(path.join(dir, `case${i}.sh`))
    assert.ok(got.equals(Buffer.from(`${content}\n`)), `case${i}: 得到 ${got.length} B，期望 ${content.length + 1} B`)
    fs.rmSync(path.join(dir, `case${i}.sh`), { force: true })
  }
  assert.ok(true)
})

// ── 落盘操作：备份语义不可破 ─────────────────────────────────────────────────
function fakeBundle(): { file: string; pristine: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-wsl-fake-"))
  const file = path.join(dir, "extension.js")
  const pristine = `"use strict";${"x".repeat(4096)}${PRISTINE}${"y".repeat(4096)}`
  fs.writeFileSync(file, pristine)
  return { file, pristine }
}

test("patch → 备份(pristine) → 幂等 → restore 回到原始", () => {
  const { file, pristine } = fakeBundle()
  assert.equal(statusOf(file).state, "pristine")
  const r = applyPatch(file)
  assert.ok(r.ok && r.changed && statusOf(file).state === "patched")
  assert.equal(fs.readFileSync(backupPathOf(file), "utf8"), pristine, "备份必须是未修改的原始内容")
  assert.equal(applyPatch(file).changed, false, "重复 patch 不该再写")
  const res = restore(file)
  assert.ok(res.ok && res.changed)
  assert.equal(fs.readFileSync(file, "utf8"), pristine)
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test("备份一旦被写下就永不覆盖；--force 无备份则拒动；漂移不改文件", () => {
  const { file, pristine } = fakeBundle()
  applyPatch(file)
  const bak = backupPathOf(file)
  fs.writeFileSync(bak, "TAMPERED")
  applyPatch(file)
  assert.equal(fs.readFileSync(bak, "utf8"), "TAMPERED", "工具不该动已有备份")
  fs.rmSync(bak, { force: true })
  const r = applyPatch(file, { force: true })
  assert.equal(r.ok, false, "--force 没有备份时拒绝破坏性操作")
  assert.ok(fs.readFileSync(file, "utf8").includes(MARKER))

  const drift = path.join(path.dirname(file), "drift.js")
  fs.writeFileSync(drift, PRISTINE.replace(ANCHOR, "await 0;"))
  const rd = applyPatch(drift)
  assert.equal(rd.ok, false)
  assert.equal(fs.readFileSync(drift, "utf8"), PRISTINE.replace(ANCHOR, "await 0;"), "漂移时绝不写文件")
  void pristine
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

// ── 发现与启动器 ────────────────────────────────────────────────────────────
test("只认扩展身份定位安装，并从安装根推 exe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trae-wsl-disc-"))
  const made = path.join(root, "someuser", "AppData", "Local", "Programs", "Trae CN", EXT_REL)
  fs.mkdirSync(path.dirname(made), { recursive: true })
  fs.writeFileSync(made, "bundle")
  fs.mkdirSync(path.join(root, "someuser", "AppData", "Local", "Programs", "OtherApp"), { recursive: true })
  const found = discover({ usersRoot: root, platform: "win32" })
  assert.equal(found.length, 1)
  assert.equal(found[0]?.app, "Trae CN")
  assert.equal(appRootOf(made), path.join(root, "someuser", "AppData", "Local", "Programs", "Trae CN"))

  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trae-wsl-exe-"))
  assert.equal(traeExeIn(appRoot), undefined, "只有空目录时宁可不给")
  fs.writeFileSync(path.join(appRoot, "unins000.exe"), "")
  fs.writeFileSync(path.join(appRoot, "trae-http-helper.exe"), "")
  assert.equal(traeExeIn(appRoot), undefined, "卸载器/helper 不算主程序")
  fs.writeFileSync(path.join(appRoot, "unins000.exe.bak"), "")
  fs.writeFileSync(path.join(appRoot, "Trae CN.exe"), "")
  assert.equal(traeExeIn(appRoot), path.join(appRoot, "Trae CN.exe"))
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(appRoot, { recursive: true, force: true })
})

test("启动器与工具目录：CRLF、走 if-stale、绝不落在 Trae 安装目录里", () => {
  const cmd = launcherContent({ toolFileWin: "C:\\Users\\someone\\AppData\\Local\\trae-wsl\\trae-wsl.mjs", traeExeWin: "C:\\x\\Trae CN.exe" })
  assert.ok(cmd.includes("\r\n") && cmd.includes("if-stale") && cmd.includes("trae-wsl.mjs"))
  assert.ok(!cmd.includes("WSLENV") && !cmd.includes("IDE_WSL_COMPAT"), "修 Trae 不需要任何登录 shell 配合")
  const d = defaultToolDir({ LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local", USERPROFILE: "C:\\Users\\someone" })
  assert.equal(d, path.join("C:\\Users\\someone\\AppData\\Local", "trae-wsl"))
  assert.ok(!/[Pp]rograms[\\/]+Trae/.test(d), "工具不能放在会被更新整体替换的 Trae 目录里")
})

test("bin 写法不会被 npm 静默删掉（带 ./ 前缀时 npm publish 会移除 bin）", () => {
  const p = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "package.json"), "utf8")) as {
    bin: Record<string, string>
    files: string[]
  }
  for (const [name, target] of Object.entries(p.bin)) {
    assert.ok(!target.startsWith("./"), `bin["${name}"] 不能带 ./ 前缀，否则 npm publish 会把它删掉`)
    assert.ok(p.files?.includes(target.split("/")[0] ?? ""), `bin 指向的 ${target} 不在 files 白名单里`)
  }
})
