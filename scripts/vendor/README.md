# 固定 mygo 依赖

仓库使用 Go 标准 `vendor/` 保存应用和官方 CLI 实际需要的依赖源码。Go SDK、`mygo-runtime` 与 `mygo-cli` 统一固定为 `0.9.0`，没有本地 `replace`，也不修改 Go 模块缓存。

## Windows 修正

原本的 `windows-transparent-shadowless-frame-v3` 补丁已合入 mygo 0.9.0：透明网页窗口使用 `WS_EX_NOREDIRECTIONBITMAP`；透明、无边框、无阴影且无材质的网页窗口禁止绘制 DWM/GDI 非客户区边框，保留缩放命中测试。上游同时覆盖了 Windows 10、Windows 11、原生 UI 和材质窗口的区别。

本项目不再重放该补丁，vendor 保留官方源码原始字节。原文件版权、依赖许可证及 notice 继续保留。Windows 实机验收仍需确认桌面歌词透明、无细边框、缩放与锁定穿透。

## 构建与校验

安装 Node 24、pnpm 10.28.1 和 Go 1.27.3 后运行：

```sh
pnpm vendor:check
pnpm generate:desktop
pnpm build:desktop:win
```

开发使用 `pnpm dev:desktop`，其他平台使用 `pnpm build:desktop:mac` / `pnpm build:desktop:linux`。这些入口先核对完整 vendor 摘要和 Go 依赖摘要，再以 `GOWORK=off`、`GOFLAGS=-mod=vendor` 调用固定官方 CLI；应用运行时不需要 Node。

`vendor-lock.json` 的第 2 版格式锁定 SDK 版本、go.mod / go.sum 摘要、文件总数和整树 SHA-256，不再包含本地补丁编号。整树摘要按相对路径排序，依次写入 `路径 + NUL + 文件长度 + NUL + 原始字节 + NUL`。`.gitattributes` 禁止 vendor 的换行转换，校验拒绝符号链接和特殊文件。

## 重新生成依赖

```sh
pnpm vendor:refresh
pnpm vendor:check
pnpm test:desktop:vendor
pnpm test:desktop:release
```

刷新在临时目录执行 `go mod vendor`。确认生成期间 Go 依赖未变化后，生成新摘要并替换 vendor 和锁定文件；生成或替换失败时保留原 vendor。不要直接运行 `go mod vendor` 绕过这条流程。

SDK 升级时同步修改 `scripts/vendor/mygo.mjs`、Go 与 npm 版本，重新生成绑定与依赖锁，审查生成差异。禁止把临时目录或私有绝对路径写入正式依赖。

## Windows 窗口消息测试

在 Windows 上运行 `pnpm test:desktop:windows-sdk`。命令通过 Go overlay 将 `scripts/vendor/_tests/window_frame_test.go` 加入实际 vendored SDK，验证透明歌词窗口抑制非客户区绘制，而普通窗口、阴影窗口和原生 UI 不受影响。该测试是项目回归检查，不修改上游源码。

macOS／Linux 只能交叉编译测试，不能据此宣称 Windows 执行通过：

```sh
GOOS=windows GOARCH=amd64 pnpm test:desktop:windows-sdk -c -o build/mygo/windows-frame-policy-tests.exe
```

交叉编译不代替 WebView2、桌面歌词、托盘及安装程序的实机验收。WebView2 原生安装引导仍按用户安排暂停，Windows 安装器仍需要 NSIS。
