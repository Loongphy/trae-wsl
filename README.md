# trae-wsl

解决一个问题：**Trae CN 的「IDE 模式」连 WSL 时，如果你的 Linux 默认登录 shell 是 `fish`，会卡在**

```
Step install_wsl_server failed: Failed to deploy startup script to WSL:
Failed to write script file with exit code: 127
```

原因：Trae 内置的 `cloudide.icube-remote-ssh` 用 **heredoc** 把启动脚本下发进 WSL，而它调 WSL 用的是
`wsl --distribution D -- bash -c <载荷>`（不是 `--exec`），并且 spawn 时 `windowsVerbatimArguments: true`
（参数不加引号）。于是这段裸文本被交给**默认登录 shell** 去解析：

```sh
bash -c cat > "/tmp/trae_script_x.sh" << 'EOF' … EOF
```

bash 当这个外层 shell 时歪打正着能产出正确文件，fish 没有 heredoc，解析期就报错 ⇒ exit 127。

修法：只把那一处换成单行、外层单引号、引号内只有 base64 的命令 ——

```sh
bash -c 'echo <BASE64> | base64 -d > "<t>"'      # 超过 18 KB 自动分块：先 > 后 >>
```

外层 shell 无事可解，只能整串交给内层 bash ⇒ 与"外层是什么 shell"解耦。落盘字节与原 heredoc 完全一致
（含结尾换行），所以 `test -s` / `wc -c` / 脚本自身都不变。**不动你的 shell 配置**：没有登录 shell 包装、
没有 `chsh`、没有 PATH 遮蔽。

非官方工具，与字节跳动 / Trae 无隶属关系；会修改第三方应用目录里的文件，风险自负；Trae 更新会覆盖补丁
（用下面的 launcher 自愈）。

## 用法

```bat
npx trae-wsl status
npx trae-wsl patch
npx trae-wsl install-launcher
```

| 命令 | |
| --- | --- |
| `status` | 只读：每个候选 bundle 的状态（`--json`） |
| `patch` | 打补丁；原始 bundle 备份在它旁边，只写一次、永不覆盖 |
| `restore` | 从备份还原 |
| `if-stale` | 给启动器用：未打才打，静默；退出码 `0` 成功 / `3` 锚点漂移 |
| `install-launcher` | 把单文件工具 + 自愈启动器写到 `%LOCALAPPDATA%\trae-wsl`，之后把 Trae 快捷方式的「目标」指过去即可（每次启动自动补打） |
| `explain` | 根因，可贴给上游 issue |

选项：`--target <path>`（`C:\…` 与 `/mnt/c/…` 都吃）、`--force`、`--json`、`--dir`、`--trae-exe`。

上游改了代码形状时，工具会报 `drift-anchor` 并**拒绝修改任何文件**（退出码 3），同时打印周边原始字节；
它从不猜测。

## 开发

```sh
npm install
npm test              # 10 项，不需要 WSL / Windows / fish
npm run typecheck
npm run build         # tsdown -> dist/cli.mjs（单个自包含 ESM 文件）
```

发布由 `.github/workflows/release.yml` 在 GitHub Release 发布时自动完成（npm Trusted Publishing /
OIDC，仓库内存无 token）。
