import { defineConfig } from "tsdown"

// 单入口 + 单格式：产物必须是一个能复制到任意目录直接跑的单文件
// （多入口会把共享模块切成 chunk，那样 dist/cli.mjs 就不再自包含）
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  clean: true,
  sourcemap: false,
  minify: false,
  outDir: "dist",
})
