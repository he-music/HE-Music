# mpv 原生运行时阶段检查点

本阶段完成 Go/mygo 原生运行时与类型化平台 provider，供后续资源分发、`MpvPlaybackEngine`、设置与主播放器接入使用。没有改动浏览器引擎接口、主播放器或设置 UI。没有启动、附着或停止用户 App，没有读取真实曲库或账号。

## 实现边界

- 最小 purego 绑定核对 mpv v0.42.0 的 `include/mpv/client.h`，接受客户端 API 2.6 及同主版本兼容扩展。未导入会在 `init` 中加载库的 go-mpv。
- `MpvPlayback.Initialize` 仅从 `mygo.PathResources/mpv/` 加载 `libmpv.2.dylib`、`libmpv-2.dll` 或 `libmpv.so.2`，渲染进程不能传入动态库路径。Windows 依赖仅搜索随包 DLL 目录和 System32。缺库、符号或 ABI 错误可分类返回；应用启动与绑定生成不加载库。
- 所有 C 调用均由同一会话互斥锁串行化，事件和 node 在下一次 `WaitEvent` 或释放前复制。动态库保持进程常驻，实例与文件读者按生命周期销毁。
- 事件通过独立 Go 队列调度至 mygo 主线程；持会话锁的线程不等待主线程。主线程撤销仅交换原子令牌；异步清理按队列身份验证，不能销毁后续实例。队列合并连续进度，丢弃旧会话事件。
- `Load` 先停止并确认旧实例 idle、排空旧事件，再暂停加载新源。加载解析期间的暂停、seek、换源、stop、owner 撤销保持最新意图。仅当前 playlist entry 的自然 EOF 发出 `ended`。
- 指定输出设备先枚举校验，选择失败仍保留新 ID 并暂停，后端不自动探测其他输出；轮询发现设备消失时暂停并报告 `device` 错误。暂停命令失败则销毁输出句柄。设备属性成功表示命令受理，不能证明已经实际发声；真实后端的热插拔行为仍需下一阶段实测。
- mpv 仅收到 Go 当前网关签发的随机 ticket。本地源通过 `LocalFileRef` 与目录租约读取，网关保有受控文件读者；在线源仅接受 Go 当前监听地址和随机前缀下的 `__proxy`/`__audio`，复用现有代理、鉴权、重定向、Range 和解密链路。拒绝任意路径、其他 URL、API 路由及旧网关前缀。
- 限定独立音频 demuxer，关闭配置、脚本、视频、外部字幕/音轨和引用加载，使用 `protocol_whitelist=none` 限制 libavformat 二级访问，ticket 响应不透传清单和重定向。播放列表/HLS/DASH 首期不能作为独立音频源进入原生引擎。
- 标签保存与删除复用现有 mutation hook。钩子在文件事务期间阻止新原生读者，取消对应请求，等待原生 idle、HTTP 读者退出和租约释放后才放行；超时销毁实例并返回失败。并发 `close` 均等待同一次真实清理完成。

## 下阶段服务合同

`src/platform/mpvPlayback.ts` 导出 `PlatformMpvPlayback`、命令与生成协议类型；mygo 平台的 `platform.mpvPlayback` 为可选能力，Web 不导入运行时 Go 绑定。构造 provider 不初始化库。`onEvent` 返回只释放自身订阅的函数；`teardown` 清理全部 provider 订阅，Go 生命周期负责原生退出。

1. 先订阅 `onEvent`，再调用 `initialize()`，取得 `lifecycle`。库错误保留 `library`、`abi`、`symbol` 分类。
2. 调用 `load(lifecycle, request)`；请求包含 `url`、`format`、`fileEpoch`、`localRef`、`autoPlay`、`start`。在线源 `localRef=null`；本地源必须提供当前 `fileEpoch` 和有效 `LocalFileRef`。`format` 是音频容器标识，例如 `wav/flac/mp3/ape/dsf/dff/m4a/ogg`。`start`、快照位置和时长均为秒。
3. 返回快照表示加载命令受理，不表示音源已解码或已播放。其 `session` 用于后续源命令。`loadedmetadata/loadeddata/canplay` 与快照报告实际加载进展；`seek` 仅表示命令受理，实际完成由 `seeked` 或快照校正。
4. `play/pause/seek/setVolume/setRate/stop/clearSource` 都传当前 `lifecycle`、`session`。零会话只能用于尚未加载的初始会话，不能绕过代次隔离。`getOutputDevices/setOutputDevice/snapshot/destroy` 传 `lifecycle`。失效 owner 或代次返回取消，不发自然 EOF。
5. 音量取值为 `0..1`，速率为 `(0..8]`。默认设备为 `auto`；指定设备使用枚举原始 ID。选择设备会暂停，后续依据最新播放意图显式恢复。原生首期 `supportsEqualizer/supportsSpectrum/supportsFade=false`，`supportsRate/supportsSinkId=true`。
6. `stop/clearSource` 返回新 `session` 的 idle 快照，完成时旧源读者已释放；`destroy` 完成时 C 实例和读者已释放。引擎切换应等待这些完成确认后再让其他引擎输出。
7. 事件名为 `desktop:mpv`，载荷 `{ type, snapshot }`。快照包含 `lifecycle/session/sequence/state/position/duration/rate/volume/source/device/error`。`state`、事件和错误均生成封闭联合类型。`sequence` 在同一生命周期中递增；provider 拒绝旧生命周期、旧会话和重复/逆序快照。Go 约每 100ms 校正进度；前端歌词时钟自行使用 `performance.now()` 锚点，不能将 Go 时钟原点与 JS 相减。
8. 实际发送事件包括 `loadstart/loadedmetadata/durationchange/loadeddata/canplay/play/playing/pause/seeking/seeked/ended/emptied/error/volumechange/ratechange/timeupdate/deviceschange`；缓冲通过快照 `state=buffering` 表达。上层适配器仍需接入统一引擎接口和兼容事件。

## 实际验证

- 已读取 `use-modern-go/SKILL.md`，执行并完整阅读 `sh /Users/wangjian/.pi/agent/skills/use-modern-go/scripts/run-tool.sh list --file-path desktop/mpv_service.go` 输出，按 Go 1.27.3 编写。
- `go test ./...` 通过；`go test -race ./desktop -run TestMpv -count=1` 通过。
- 新增 17 个 Go 测试，使用临时合成文件、httptest 网关和由 C 编译器生成的隔离共享库，覆盖 loader 错误、C ABI、node/event 生命周期、自动播放/暂停/seek 竞态、逆序加载、源代次隔离、主线程撤销、设备失败/消失、网关边界、Range/重定向/清单拒绝、撤销租约、并发读者释放及 stop idle 确认。
- `mise x node@24 -- pnpm generate:desktop` 连续两次通过；两次生成的 SHA256 均为 `4bf005e9c02b8732e7d714eb544184f378c661225ec9989bb4fbfdbc7914dc33`。`pnpm vendor:check` 通过，固定 SDK 与 Windows 补丁摘要保持有效。
- `mise x node@24 -- pnpm typecheck` 通过，覆盖 Node 与 Web。
- `mise x node@24 -- pnpm exec vitest run src/platform/mpvPlayback.test.ts src/platform/types.test.ts src/utils/audioManager.test.ts src/utils/audioManager.processing.test.ts` 实际运行 3 个匹配文件、60 个测试，全部通过；其中 provider 新增 2 个事件隔离与专属订阅释放用例。仓库没有匹配的 `types.test.ts`，不计作已运行。
- 指定 `mpvPlayback.ts/mpvPlayback.test.ts/mygo.ts/types.ts` 的 ESLint 与 Prettier 检查通过。
- 所有新增 mpv Go 文件的 `golangci-lint fmt --diff` 通过；`golangci-lint run --new-from-rev=HEAD ./desktop/...` 无新增问题。全量 `golangci-lint run ./desktop/...` 未通过，仅报告未改动的两项基线：`desktop/gateway_local.go:75` 的 gofumpt 格式、`desktop/test_helpers_test.go:26` 的未使用 `requireTestError`。这两个文件与 HEAD 差异为空，未扩大修改范围。
- `CGO_ENABLED=0 go build` 已通过 darwin/arm64、darwin/amd64、windows/amd64、windows/arm64、linux/amd64、linux/arm64；输出在临时目录，没有启动产物。
- `git diff --check` 通过；未暂存、未提交。既有 `.gitignore`、浏览器实现、设计文档和临时 `.pi/settings.json` 保留。

## 保留验收

本轮按恢复任务的缩小范围完成原生运行时。C 测试库不包含 mpv 解码器，不能证明 libmpv v0.42.0 真实加载、DSF/DFF 解码、可闻发声或物理设备热插拔正确。真实 libmpv、随包依赖、二级资源限制在实际 FFmpeg/mpv 组合中的效果、三平台安装包、Windows 文件占用及歌词界面同步由后续资源阶段与引擎接入阶段验收；本轮没有把静态构建或模拟输出视为真实发声成功。
