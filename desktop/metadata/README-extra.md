# 原文件标签写回后端补充

当前资源传输已改为：本地音频通过应用网关的 `/__local/audio` 流式读取绝对路径，封面和歌词通过应用网关的 `/__local/artwork`、`/__local/lyrics` 读取绝对路径。下文是历史后端切片记录；其中音频票据、HTTP 读者排空和 `metadataAudioDrain` 接线已删除。标签保存前由播放器清空本地音源并阻止未决播放，原文件事务及身份锁继续保留。
本切片只新增 `desktop/files_metadata*.go`，使用既有 files actor、grant lease、ref、commit claim；未改 SDK、bindings、前端或设置，不会启用 localMusic。实际桥接 `bridge.go` 的 `go handleCall(...)` 在 Go goroutine 中调用绑定方法，方法内仅权限/索引检查进入 `state.main`，文件 IO、锁等待、读者排空均在其外。

## API

- `ReadMetadata(ctx, epoch, ref) MetadataResult`：完整标签、完整源 SHA256、当前 ref；32MiB 上限，30 秒上下文预算。
- `SaveMetadata(ctx, epoch, MetadataSaveRequest) MetadataResult`：请求包含 `operationId`（32 字节 hex nonce）、`ref`、读取时的 `sha256`、`metadata.Patch`。nil 字段保留，空值清空；最多 8MiB patch、128 个各类艺人值、16 张图片。操作 ID 在当前 owner/epoch 内保留最多 256 个去重记录，同一 coordinator 最多两个尚未退出的保存 worker（跨 epoch 计数）。完整结果缓存与预留总预算为 64MiB，到任一上限返回 limit；历史 ID 不淘汰，需使用新 ID 发起新操作或开启新 files session。同 ID 重试复用原结果，不再次写，包括 limit 的轻量结果。ID 代表同一操作，不应用于不同 patch。
- `CancelMetadata(ctx, epoch, operationId) MetadataResult`：只取消该 owner/epoch 的操作；等待身份锁和 drain 可以取消，不占 picker busy。ReadMetadata 没有单独取消 ID，由 grant/owner 撤销与预算取消。

`MetadataResult` 的 JSON 字段为 `code/ref/info/sha256/recoveryName/residualNames/committed`。Info/Patch 复用已有 metadata 类型，其字段遵循该类型的 Go JSON 默认拼写。成功返回新 ref/version/hash，旧身份的全部已登记别名 ref 失效。`committed` 单独表示磁盘 Rename 是否已经成功，即便随后撤销、发布索引或持久化失败也不伪装成未发生写入。撤销/取消后的迟到结果不返回标签、新 ref、hash。

主要 code：`ok`、`invalid_operation`、`invalid_baseline`、`limit`、`revoked`、`cancelled`、`timeout`、`conflict`、`unsupported`、`payload_rejected`、`attributes_unsupported`、`readback_mismatch`、`readers_unavailable`、`replace_failed`、`durability_uncertain`、`saved_cleanup_required`、`io_error`。不把带绝对路径的 OS 错误透传 IPC。`residualNames` 是清理失败的 grant 相对 artifact 名称，工作文件不代表有效备份。

## 父必须接线

1. 初始化一次包变量 `metadataAudioDrain func(context.Context, *NativeFiles, os.FileInfo) (release func(), err error)`，运行期间不可替换。该函数以 `os.SameFile` 安装 identity gate，覆盖跨 grant、硬链接、路径别名；阻止新票和 HTTP 读者，取消全部旧身份票及请求，在 actor 外等待真实文件句柄及 lease 关闭，再返回 release。成功返回的 release 不可为 nil，调用方将其保持到登记新 ref、清理结束。错误返回前由 hook 自行释放任何部分安装的 gate。
2. 现有 `invalidateLocalAudio(ref)` 只匹配 FileID+Version，不能用于本合同的别名失效/排空。现有 ticket.done 也只表示票 lease 的取消回调结束。父应在 pending open 读取开始前及 HTTP resolve 前登记身份 reader，在实际 FD/lease 结束后关闭 reader.done；open 到安装 ticket 的间隙同样需要 gate 原子检查。metadata 本身的读取/写入使用 SameFile 槽，关闭 IO 后释放槽。
3. hook 未接时，如已有 audioServer，写回安全拒绝 `readers_unavailable`。没有 server 时持 registry 锁直到事务结束，防止检查之后首次创建 server。这个 fallback 不是完整播放集成验收。
4. 扫描入口在解析/登记之前跳过每级名称前缀 `.hemusic-metadata-`，不能仅依赖扩展名。内部工作文件/备份可能是完整有效音频；目前扫描未接过滤，不得把本切片声明为完整产品交付。
5. 新 API bindings 与 UI 由父接入；不接受机器路径为授权参数。

## 事务、属性与恢复责任

只读打开并确认源 ref，关闭探测 FD 后获取 SameFile 可取消槽，再重新 resolve。对源计算完整 SHA256，比对用户基准；在固定父 os.Root 内以 O_EXCL、随机 32 字节 nonce、0600 创建工作文件，复制后验证其完整 hash 等于基准。正式调用 metadata.EditWorkingCopy，随后 CompareAudioPayload 硬门及 Parse 重开检查 patch 目标字段。比较器保证限定布局的编码音频区域一致，不是 PCM 解码验证。

另建同目录 O_EXCL 独立 backup，复制原件并以完整 SHA256 验证，复制属性后 Sync；工作文件属性也复制并 Sync，父目录 Sync。排空后重新 resolve 原件、核对身份/版本、完整 SHA256 和父目录身份，再通过既有 claim。Rename 直接以工作文件替换原始 basename，不先移动原件，因此 Rename 失败原件仍在；不执行 truncate fallback 或盲目覆盖恢复。成功后 Sync 父目录、注册新 ref、删除全部旧别名索引，再删除 backup。

macOS 使用既有 purego 动态调用 libSystem 的 `fcopyfile(fd, fd, NULL, 7)`。本机 SDK copyfile.h：ACL=1、STAT=2、XATTR=4，METADATA=7，不含 DATA；man copyfile 允许 NULL state，EXCL/NOFOLLOW 是路径 API 标志，不用于 FD API。先拒绝任意非零 BSD flags 和 setuid/setgid，避免错误 staging/清理；复制后检查 owner/group/mode/flags 一致。ACL、xattr 由系统 API 复制，错误则拒绝，不静默降级。临时文件最初 0600，最终准备阶段按源属性设置权限以保证替换后的属性。非 Darwin 明确 `attributes_unsupported`；Linux 已交叉编译，不代表运行验收；未运行 Windows。

异常时：

- claim 前失败一般删除 work/backup，删除失败以 `residualNames` 返回相对名；源没有被此事务改写。
- claim 后 Rename 失败保留完整 backup，`replace_failed + recoveryName`；原件保持原位。
- Rename 成功后 fsync/index/撤销失败保留 backup，返回 `committed:true`，不向已失效 renderer 发布新 ref。
- backup 删除失败返回 `saved_cleanup_required` 和相对 recoveryName。
- 本切片不提供任意路径恢复 IPC，也不自动把 backup 覆盖回某路径。父/用户须在重新授予目录后检查当前文件与备份，再做明确恢复处理。不能自动覆盖外部新文件。
- 进程崩溃可能留下 `.hemusic-metadata-work-*` 或 `backup-*`；工作文件可能不完整，只有名字无法证明事务阶段。恢复人员应保留并核对内容、音频负载、源路径与身份，不能仅根据文件时间猜测后自动恢复。当前没有持久化日志或启动恢复 UI；需要父后续接线。文件/目录 Sync 不承诺所有硬件/文件系统断电行为。

os.Root 固定 IO 范围，逐级现有路径校验拒绝 symlink、特殊文件与检测到的父目录替换。最终检查与 Rename 之间没有跨进程 CAS；外部进程在这个窗口写入/替换源或临时 artifact 的竞态没有消除，不能声称保证不会覆盖这种未知外部内容。外部 ACL/xattr 变化也没有独立版本 token。硬链接写回只替换选中目录项，其他硬链接仍指向旧 inode；其登记 ref 被失效，需要重扫，不能声称所有硬链接内容同时更新。

## 实际验证边界

测试只用临时生成音频、fake actor/provider 和系统 FFmpeg/ffprobe/xattr/chmod；产品代码不执行这些命令。MP3 ID3v2.3 与 FLAC 原件真实替换通过，中文标题、多艺人、清空、未知 RawFrame/comment、xattr 和 ACL 保留；独立 ffprobe 逐包 SHA256 前后一致。覆盖同操作去重不双写、旧 ref 失效、大小与操作数限制、可取消身份锁/超时、外来 owner 取消拒绝、grant 撤销、drain cancel、存在 server 的拒绝、同 size+mtime 外部改字节冲突、目录只读导致 Rename 失败与完整 backup 保留。

首次新增 fixture 编译使用了不存在的 mtag AddFrame/SetCustom/Custom，实际编译失败；按固定版本已有 Set/SetCustomValues/CustomValues 修正。随后取消结果收尾覆盖 revoked 为 cancelled 的测试失败已修复，最终以 lease 撤销检查优先。把 drain gate 生命周期延长至实际 FD 关闭与清理结束后，目录只读故障测试发现 work 无法删除；实现已通过 residualNames 记录，测试修正为确认 backup 与 work 均保留并分别标明角色，不再错误断言只剩 backup。最终检查见任务交付报告。不将 parser/readback 或 ffprobe packet hash 外推为所有 MP3/FLAC 变体、PCM 解码、真实 App/本机播放/用户音乐库验收。

## 独立审查修复：会话注册、缓存预算及清理

本轮修复 review 的两个 P1 与一个 P2，没有改变公开 API、完整成功结果重试协议、metadataAudioDrain 签名或父接线责任。

注册、会话推进、完成发布、重试读取及取消均遵循 actor → coordinator.mu：在同一 actor turn 内 checkLeaseOnMain 后短持 coordinator 锁，不存在 coordinator.mu → main 的反锁顺序。旧 lease 已取得但尚未注册时发生 epoch 切换，旧请求只能被拒绝，不能清掉新会话记录。旧 worker 持 job 指针收尾，退休后不得重新放回 map；活动 SameFile slots 与 active worker 数独立于 jobs 退休，直到实际 IO 与清理结束才退出。

预算常量：最多 256 个去重记录，每个固定 16KiB 轻量额度；完整 Info 的预算为 64MiB − 256×16KiB = 60MiB。cachedBytes 计入所有已登记记录的轻量额度及完整结果/未完成 reservation，始终不超过 64MiB。16KiB 覆盖 ref、操作 ID、返回 code、恢复/残留名称、watch 等固定内容；请求 ref 的 relativePath 限 4096 字节，fileId/version 限 64 字节。Info 将字符串与数组/图片 detach，避免小视图保留未计入的大 parser backing buffer；完整 Info 额度包括全部文本字节、艺人数组容量、图片数组容量与图片 Data 容量，采用保守结构开销。watch 仅捕获 operationId/job，不保留包含大图片 patch 的请求结构。

正式编辑和回读成功后、创建 backup 与 claim/Rename 之前，actor 校验下原子预留完整 Info 额度。超限返回 limit，不发生原件替换，并保留该 ID 的轻量结果；不得 LRU 删除历史 ID。失败/主动取消释放未完成 Info reservation，完整成功结果保留原样用于重试；已完成操作的 CancelMetadata 是幂等空操作，不丢历史成功结果。同步 CancelMetadata 会即时释放未完成 reservation；deadline/操作上下文取消也有 watcher 释放。两个 active worker 的 permit 从注册一直持有到文件句柄关闭、清理及完成收尾，不因取消请求或新 epoch 提前释放。达到并发上限的新 ID 同样保存轻量 limit 结果，重试同 ID 不会随后变成一次写入。

completed cache 的生命周期单独 watch handle.leaseContext 和 owner context，不能使用正常 Release 会取消的 lease.Context。grant revoke、Teardown、新 Begin 引发的旧 handle retire、owner 取消，即使没有后续 Save，也异步移除旧记录、断开结果/ref/owner 引用、清零其缓存与 reservation 计数，并停止另一 watch。旧 worker 正在实际 IO 时只取消、清 reservation，不拆除身份槽和 active permit；最终 finish 仅关闭它自己的 done 与释放 permit。coordinator 空壳可继续复用，不能删除仍承载活动身份槽的 registry 对象。

先新增回归测试，真实观察到：迟到 A 使 B Cancel 返回 invalid_operation、B 成功重试返回 conflict；连续 6MiB 封面编辑缓存达到 69,206,016 字节；grant revoke 后旧 Info 仍在；第三并发保存实际 committed。修复后均转绿。另覆盖 cancel 立即释放 reservation 但 IO permit 仍持有、owner/session/grant 在无后续保存时清理缓存、普通 lease.Release 保留去重、旧 IO 排斥新身份锁、limit 及早期成功 ID 重试不再次 Rename。原先直接伪造 jobs map 的限额测试补齐新的 owner/epoch 与轻量额度状态；新增 owner fakeactor 测试曾因闭包捕获被重赋值的 ctx 失败，已使用不可变原 actor owner 修正。全包实际结果与中文 fix 提交见本轮交付报告。
