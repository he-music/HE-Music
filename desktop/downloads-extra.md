# 独立下载后端接线说明

本切片基于 `b71f007`，仅新增 `files_download.go`、`files_download_test.go` 和本文；没有接线、生成绑定、修改 scanner/core/SDK/go.mod/前端。NativeFiles 的新增方法须由父切片统一接入 mygo。

## API

```go
StartDownload(ctx context.Context, epoch uint64, req DownloadRequest) (DownloadOperation, error)
ReadDownloadState(ctx context.Context, epoch uint64, id string) (DownloadState, error)
CancelDownload(ctx context.Context, epoch uint64, id string) (DownloadState, error)
```

`DownloadRequest`：`operationId`（调用方随机生成 32 字节 hex；64 字符）、`grantToken`、`url`、`filename`。不接受路径、overwrite、headers、cookie 或持久化选项。

`DownloadOperation`：`operationId`。

`DownloadState`：`operationId`、`code`、`done`、`received`、`total`、`committed`、`filename`、可选 `residualName`、可选 `ref: LocalFileRef`。`total=0` 表示未知；不提供百分比。UI 若显示百分比，在 `done && code=="ok"` 前最高显示 99%，字节相等只表示接收结束，不能显示下载成功。`CancelDownload` 返回当时快照；它不等待实际 IO 清理，继续轮询至 `done`。旧授权/页面的调用直接返回静态错误，不再提供状态或 ref。

开始/查询/取消错误均为既有静态 files 错误或 `download request rejected`，不能当作底层错误串展示。异步 `code` 为 `running`、`ok`、`io_error`、`invalid_request`、`network_error`、`http_rejected`、`limit`、`payload_rejected`、`unsupported`、`revoked`、`conflict`、`atomic_commit_failed`、`sync_failed`、`registration_failed`、`cleanup_failed`、`cancelled`、`timeout`。

同 session 同 ID、同请求只能复用同一 operation；改变目录/URL/名称会拒绝。撤销 grant 后保留不可复用 ID 墓碑。最多两项实际未清理任务、128 条记录；满额返回 busy，不淘汰终态后暗中重下。新 session 清退旧索引，但旧任务直到实际清理完才还 active 许可。重试必须使用新 ID 并重新提供有效授权和 URL；已发布名称永不自动覆盖。任务不持久化，只缓存请求摘要及有界状态/ref，不缓存 signed URL、图片、附件、歌词或 metadata.Info。

## 父切片接线

- 仅从用户明确授权的下载目标目录获取 grantToken，沿用现 DirectoryGrant 生命周期；默认目录显示不等于授权。不启动额外 picker，不占 picker busy。
- mygo 开始调用必须保持页面 session context 与 epoch 身份；不能用独立后台 context 冒充页面 owner。
- 用 operationId 跟踪队列和错误重试。网页下载/外部浏览器打开不能充当本地完成。
- 成功后把 `ref` 加入父 registry；完整信息可再走既有受限 metadata 读取。后端已校验内容，但本 API 故意不缓存 metadata 结果。
- **scanner 在每一级遍历均需忽略 `.hemusic-download-` 前缀**，包括 crash 后遗留私有临时件。本切片按限制未修改 scanner；父接线前必须补上。
- 成功条件是 `done && code=="ok" && committed && ref!=nil`。任何 `committed=true` 的非成功终态，都应向用户说明目标可能已保存，展示相对 `filename`；不要自动重试覆盖。`residualName` 是清理失败的私有临时名称，不是机器路径。
- `atomic_commit_failed` 明确表示不能原子发布；不支持同 Root 硬链接 no-replace 的 FS/平台拒绝，不做 Rename/truncate/copy fallback。

## 实现与边界

后台 HTTP/IO 使用两分钟 context。仅 HTTP(S)、无 userinfo、无 fragment，redirect 最多十跳并重新验证协议/凭据；去掉 redirect Referer，避免 signed query 变成下一站 Referer。没有 cookie jar、环境代理、应用 headers、日志或原始 OS/HTTP 错误返回。没有 Node、sidecar 或 socket 服务。HTTP 仅接受完整 200，拒绝 Content-Range/206 和压缩表示；Content-Length 预检加流式 32MiB 硬限，未知长度同样计数。

名称为安全单层 MP3/FLAC basename，拒绝分隔符、冒号、控制字符、隐藏/设备名和通配符。源工作件采用同 Root `.hemusic-download-<256-bit-random>`、O_EXCL、0600。完成后调用 ParseScan（跳过图片/附件），限定实际容器与扩展名一致，随后 CompareAudioPayload(source, source) 校验支持的完整受限布局；这是 framing/CRC/packet 验证，不是 PCM 解码、HTTP 来源真实性或唱片真实性承诺。

提交前 file Sync；actor 内授权检查与 operation context/commit gate claim；随后 actor 外 Root.Link(tmp, filename) 原子 no-replace。已存在目标（含目录/链接）绝不覆盖，同名竞争只有一个成功。Link 后检查身份、目录 Sync、注册新 ref；任一后续失败保留 committed=true，绝不删除或恢复覆盖已发布真实目标。取消在 claim 之后可能仍发布目标，终态如实保留 committed。

request context、body 和临时 FD 都随取消关闭；sync.Once 同步等待正在执行的关闭完成，再删除临时件、finish claim、Release lease，最后完成状态/done 并归还 active。完成结果监听 handle.leaseContext/owner，普通 lease.Release 不会清除结果。所有 actor/coordinator 组合锁顺序固定 actor→coordinator；旧 epoch 的完成/撤销不能删除新任务。

外部进程仍能修改目录、工作件和已发布文件；本组件不承诺文件系统范围事务或排除同用户恶意竞争。Root 固定授权目录的实际对象，外部移动该对象不等于路径仍可见。文件/目录 Sync 成功不保证所有远端/虚拟 FS 或断电行为；临时件 unlink 后没有额外目录 fsync，崩溃可能遗留私有名称（包括与已发布目标同 inode 的硬链接）。不存在自动 crash 恢复、持久任务或跨 session 去重。协调器按 NativeFiles state 在进程内保留小型有界状态，应用应复用原 NativeFiles 实例。

## 隔离验证

所有新增测试使用 t.TempDir、代码生成的两帧 MP3/原生 FLAC、fake RoundTripper/body/actor；没有 App/Vite/picker 交互、真实音频、用户库、外部网络、真实监听 socket、账号或 Windows 请求。

覆盖：双格式成功与全文件 SHA256/packet 比较；同 ID 幂等及变更拒绝；已有目标不覆盖；并发同名竞争；206/Content-Range/长度超限/未知长度累计超限/截断/坏帧/格式不符；取消和撤销关闭 blocked body、实际 Close 完成前 lease/许可/done 不提前；claim 后取消仍诚实报告 committed；late epoch 不影响新任务；128 条记录上限及终态保留；授权 progress/未知 total/普通 Release 后终态仍在；危险 basename/URL/redirect 和错误脱敏。

固定 Go 1.27.3，GOTOOLCHAIN=local、GOWORK=off、CGO_ENABLED=0、GOPROXY=off、GOSUMDB=off、-mod=readonly。精确命令与输出见交付报告；没有运行 race，没有声称 Windows、崩溃/断电或实际 UI 验证。
