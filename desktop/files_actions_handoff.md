# 本地文件菜单 Native seam 交接

本 lane 仅新增 `desktop/files_actions.go`、`desktop/files_actions_test.go` 与本文档；不修改已有生产文件，不删除 Electron，不修改 SDK、依赖或生成绑定。

## 调用契约

- `NativeFiles.RevealLocalFile(ctx, epoch, ref) FileActionResult`
- `NativeFiles.RemoveLocalFile(ctx, epoch, ref) FileActionResult`
- `FileActionResult` 的 JSON 为 `{ "code": string, "removed": boolean }`。
- `ref` 是当前 session/grant 注册的完整 `LocalFileRef`，不是 renderer 提供的绝对路径。复用现有 `metadataCode`，路径和原始 OS 错误不返回 renderer；无法获得音频排空保证时返回 `readers_unavailable`。
- Reveal 的 `ok` 代表已向 SDK `Shell.ShowItemInFolder` 分发请求。SDK 不返回文件管理器是否成功显示的状态。`removed` 始终为 false。
- Remove 永久删除请求对应的一个目录项，不删除 `.lrc`、图片或其他侧车，也不移除其他硬链接目录项。`removed=true` 是删除已经发生的事实；即使随后 owner 撤销使 `code=revoked`，前端仍必须按已经删除处理。
- 无新增文件字节大小上限。

## 安全和并发边界

同步方法一直持有 `acquireDirectory` 得到的 lease，关闭所有自持文件后才释放；不创建可提前遗失 hold 的后台 IO worker。复用 `resolveLocalFile` 的 ref/version/父目录/身份校验，复用 `metadataCoordinatorFor` 的 SameFile 身份锁，串行化同一文件及其硬链接的 metadata 保存与菜单操作。

删除先通过 `metadataAudioDrain` 安装音频身份 gate，取消票据及读者并等待实际 FD/lease 读者排空；排空后再次 resolve。若 hook 缺失且已有音频 server，或 hook 成功却没有 release，则拒绝删除。没有 server 时持有音频 registry 锁，阻止删除期间创建首个 server。

父目录通过 `os.Root.OpenRoot` 固定，在 claim 前后检查父目录 route 与叶子身份，最终只调用该 pinned Root 的 `Remove(baseName)`。`fileCommit` 的取消 watcher 只使尚未 claim 的请求失效；已 claim 请求持有额外 Root 引用，允许撤销后完成，并由 `finishFileCommit` 释放。成功后在 actor 清理原身份及所有已注册 SameFile alias 的 ref/path 映射，同时失效请求及 alias 的 library metadata cache。硬链接剩余目录项可再次扫描获得新 ref。

与现有 metadata 事务相同，`os.Root` 与身份复查不能提供针对外部进程替换目录项的文件系统 compare-and-swap。Reveal 需要绝对路径，因此额外检查 canonical grant 路径和最终文件身份；系统接收路径后的外部更改也无法原子排除。

## 父任务接线

父任务负责 `FrontendFilesSession`、菜单调用、国际化及官方 generate。沿用 Electron 菜单行为：用户确认后才调用永久删除；当前播放文件禁止点击删除。收到 `removed=true` 后应更新列表并丢弃旧引用，即使 `code` 表明 owner 已切换。Reveal 直接使用当前 ref，不从 UI 路径重建权限。

`fileActionReveal` 是包内可替换 backend，默认调用固定 SDK 的 `Shell.ShowItemInFolder`。所有新增测试 fixture 都替换这个 backend，不调用真实文件管理器。没有启动真实 App、访问用户曲库、播放声音或发起网络请求。

## 验证

环境：`go version go1.27.3 darwin/arm64`，固定仓库依赖，所有 Go 检查使用 `GOTOOLCHAIN=local CGO_ENABLED=0 GOPROXY=off GOSUMDB=off`。

已通过：

```sh
GOTOOLCHAIN=local CGO_ENABLED=0 GOPROXY=off GOSUMDB=off go test ./desktop -run '^(TestFileActions|TestDirectoryLease|TestFileCommit|TestLocalFile|TestOwnerReplacementKeepsRoot|TestMetadataIdentityLock)' -count=1 -timeout=45s
GOTOOLCHAIN=local CGO_ENABLED=0 GOPROXY=off GOSUMDB=off go vet ./desktop
GOTOOLCHAIN=local CGO_ENABLED=0 GOPROXY=off GOSUMDB=off GOOS=linux GOARCH=amd64 go test -c ./desktop -o "$build_dir/desktop.test"
GOTOOLCHAIN=local CGO_ENABLED=0 GOPROXY=off GOSUMDB=off GOOS=windows GOARCH=amd64 go test -c ./desktop -o "$build_dir/desktop.test.exe"
```

交叉编译各使用独立的 `/private/tmp/hemusic-files-actions-{linux,windows}.*` 临时目录，未运行跨平台产物。

新增 10 个测试入口覆盖：Reveal backend/结果 JSON、非法 owner/epoch/grant/ref/路径、文件/符号链接/父目录替换、grant 移动后 Reveal 拒绝、仅移除原件且保留侧车和硬链接、alias/cache 失效、metadata 身份锁等待及撤销、硬链接读者实际排空与 gate 拒绝新读者、排空后撤销或替换、缺失排空能力、claim 后撤销仍报告已删、claim 后替换拒绝及 Root/gate 释放。

未运行完整测试套件（其中存在网络及真实平台集成场景）、真实 UI/文件管理器交互或 race 检查（本任务固定 CGO=0）。独立 reviewer gate、前端接线与官方 generate 待父任务执行。没有暂存或提交文件。
