# 固定 mygo 依赖与 Windows 透明补丁

仓库使用 Go 标准 `vendor/` 保存应用和官方 CLI 实际需要的依赖源码。`go.mod` / `go.sum` 的 mygo 版本仍固定为 `v0.6.5-0.20261026063203-07ebe19ac0dc`，没有本地 `replace`，也不修改 Go 模块缓存。

## 补丁范围

`patch.json` 保留已在用户 Windows 实体机验证过的 v2 透明修正：创建透明网页窗口时启用 `WS_EX_NOREDIRECTIONBITMAP`，避免不透明的重定向位图遮住 WebView2 透明内容。

用户随后提供了仍有细边框的 Windows 10 截图，当前补丁已追加 v3 边框修正：对透明、无边框、无阴影的网页窗口禁用 DWM 非客户区绘制，并处理 `WM_NCPAINT` / `WM_NCACTIVATE`，保留原生缩放边与命中测试。普通窗口、请求阴影的窗口和原生 UI 窗口继续使用原逻辑。

变更仍限定在 `vendor/github.com/egoist/mygo/internal/windows/window.go`。v3 结果与此前隔离候选源码字节一致，用户已确认 v3 在 Windows 实体机可用。原文件版权、所有依赖许可证及 notice 保留在 vendor 中。

## 构建与校验

安装 Node 24、pnpm 10.28.1 和 Go 1.27.3 后运行：

```sh
pnpm vendor:check
pnpm generate:desktop
pnpm build:desktop:win
```

开发使用 `pnpm dev:desktop`，其他平台使用 `pnpm build:desktop:mac` / `pnpm build:desktop:linux`。这些入口先核对完整 vendor 摘要和 Go 依赖摘要，再以 `GOWORK=off`、`GOFLAGS=-mod=vendor` 调用固定官方 CLI；应用运行时不需要 Node。

普通 `go build` / `go test` / `go tool mygo` 在当前 Go 版本下也会自动选择根目录 vendor，但使用上面的入口能在构建前检查补丁是否被覆盖。不要用 `-mod=mod` 或 `-mod=readonly` 构建交付包，它们会绕过本地补丁。自动更新发布工具同样验证 vendor 并固定使用 vendor 模式。

`vendor-lock.json` 锁定 SDK 版本、补丁编号、go.mod / go.sum 摘要、文件总数和整树 SHA-256。整树摘要按相对路径排序，依次写入 `路径 + NUL + 文件长度 + NUL + 原始字节 + NUL`。`.gitattributes` 禁止 vendor 的换行转换，以保留源码和嵌入资源原始字节；校验拒绝符号链接和特殊文件。

## 重新生成依赖

```sh
pnpm vendor:refresh
pnpm vendor:check
pnpm test:desktop:vendor
pnpm test:desktop:release
```

刷新在临时目录执行 `go mod vendor`，校验原始 Windows 文件 SHA-256，按顺序应用每处上下文唯一的文字替换，全部替换成功后才写入源码，再校验补丁结果 SHA-256。成功后替换 vendor 并更新整树锁定记录；上游版本、上下文或文件字节变化时会拒绝，保留原目录，必须先审查兼容性再更新补丁定义。不要直接运行 `go mod vendor` 覆盖已修正的 vendor。

更新其他 Go 依赖后也必须运行此命令并审查 go.mod、go.sum、vendor 和锁定文件的变化。禁止把临时目录或私有绝对路径写入正式依赖。上游正式包含该修正后，再单独升级 SDK 并移除补丁；不能自动假定新版本等价。

## Windows 窗口消息测试

在 Windows 上运行 `pnpm test:desktop:windows-sdk`。该命令把 `patches/mygo/_tests/window_frame_test.go` 通过 Go overlay 临时加入真实 SDK 包，检查透明歌词窗口抑制非客户区绘制，而普通窗口、阴影窗口和原生 UI 不受影响。测试过程不改 vendor，也不更新锁定记录。

macOS／Linux 只能交叉编译该测试，不能据此宣称 Windows 执行通过：

```sh
GOOS=windows GOARCH=amd64 pnpm test:desktop:windows-sdk -c -o build/mygo/windows-frame-policy-tests.exe
```

## 验证边界

v2 补丁已有 Windows 实体机透明显示确认，本次纳入已通过正式入口构建和空模块缓存／禁用下载的依赖验证。交叉编译不代替新包的 WebView2、锁定穿透、托盘或安装程序实机验收。WebView2 原生安装引导仍按用户安排暂停，Windows 安装器仍需要 NSIS。
