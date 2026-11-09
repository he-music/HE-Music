# 本地音乐标签适配合同

本包使用 `github.com/tommyo123/mtag` 固定提交
`57fea0d75b4f88edcdee8ca75e9423d522023f86`。GitHub API 已核对 `v1.0.2` 指向该提交。
本地业务开放 MP3、WAV、FLAC、AAC、WebM、M4A、MP4、OGG、AIFF、AIF、APE、DFF；适配层按实际容器读写，未知容器返回 `ErrUnsupportedContainer`。扫描和播放独立于标签解析，无法读取标签时仍可按文件名收录。
包不打开路径、不负责授予文件权限，也不执行原件替换。

## 调用合同

- `ParseScan(io.ReaderAt, size)`：只读扫描，使用上游跳图/附件选项，结果
  `PicturesLoaded=false`。不能把该视图用于保存。
- `Parse(io.ReaderAt, size)`：只读完整编辑视图，返回所有图片及其 MIME、类型、描述、字节。
- `EditWorkingCopy(ctx, WorkingCopy, size, Patch)`：对调用方提供的私有工作副本重新完整打开，
  检查所有 setter 错误后保存。调用方持有和关闭句柄，同一副本不得并发访问。
- `Patch` 指针为 nil 时保留；指向空字符串/空数组时清空。
  `Pictures` 非 nil 时替换全部封面，与现有 SongInfoEditor 保存行为对应。
- `Artists` 是表演艺人；`AlbumArtists` 是专辑艺术家，二者独立。
  旧 Electron 扫描将 albumArtists 映射为展示 artists，父集成须显式保持或决定更换该业务映射，
  不应误以为两组原生标签相同。编辑器 `alia` 对应 `Comment`，不额外伪造通用 description。
- MP3 原生多值写入 TPE1/TPE2；FLAC、Ogg 写重复 ARTIST/ALBUMARTIST comments。
  不拆分或拼接 `/`、`;` 等字面字符。修改 Vorbis 专辑艺术家时清除旧 `ALBUM ARTIST` 别名。
  v1-only MP3 写入先提升到 v2.4，v1 只能保留主艺人，完整数组存在 v2。
- 普通歌词/LRC 文本作为普通歌词存储；未提供原生 SYLT 创建/编辑接口。
- 时长为秒，码率为 kbps（上游 bits/s 除以 1000），采样率为 Hz，位深为 bit/sample。
  0 表示未知或不适用；不由文件后缀推断无损。短 MP3 码率是上游估计，测试样本约
  139.594 kbps，不等于编码目标精确 128 kbps。
- DFF 的标签使用 `ID3 ` 区块，兼容未压缩 DSD 与 DST 压缩音频。DST 时长取自
  `FRTE` 帧数/帧率，DSD 时长按音频字节数、采样率和声道数计算；两者位深为 1。
  完整性校验保护所有非 ID3 区块，检查 DST 帧边界和数量；带 `DSTI` 的文件还保护
  音频位置，拒绝会移动音频却不更新绝对索引的标签重排。此校验不负责解码 DST。
- 本地标签保存使用 `CompareMetadataPayload` 核验编辑前后内容保留，不要求原文件的音频帧和尾部数据通过下载格式验收。FLAC 保护 STREAMINFO、非受管元数据块及完整音频和尾部区域；MP3、AAC、APE 保护原生标签之外的完整区域。WAV／AIFF／DFF、Ogg、MP4／M4A 和有明确 Segment 边界的 WebM 会原样保留容器外的附加数据，并将其纳入保存校验。附加数据变化或丢失时拒绝写回，不会自动删除或修复。
- 对会丢弃容器外数据的写入器，适配层先将尾部流式暂存到私有临时文件，编辑容器后再附回；内存不随歌曲或尾部大小增长。无法确认边界、无法正确更新媒体引用等情况仍拒绝保存。`CompareAudioPayload` 继续用于下载输入的独立格式验收。

## 原始音乐文件最终写回

父 files service 应使用现有 session grant、`os.Root` 和文件身份校验：

1. 在授权范围内打开原件并捕获身份/版本，创建私有副本；对原件保持只读。
2. 将副本句柄和准确 size 交给 `EditWorkingCopy`，任何错误都废弃副本。
3. 保存后重新获取副本 size，以 `Parse` 重开验证目标字段；按 service 策略验证音频负载、
   保护媒体及必要解码配置，并处理取消。同一原件写入串行化；不设整个歌曲文件大小上限。
4. 提交前再次核对 grant、路径关系、原件身份和版本；由父实现平台替换、恢复和持久化策略。
   成功后才发布新元数据/更新索引。副本接口是原始标签更新的实现阶段，并非只导出副本的产品限制。

上游 pathless 保存内部使用 OS 临时文件，回写副本不是原子操作；错误可能使副本不可用。
本包不承诺所有失败都能回滚副本，更不提供原件替换、fsync、ACL/xattr 或占用文件处理保证。
下载、侧车 LRC/封面优先级、MD5、文件大小和 UI 桥接均留在父 service。

## 实测范围与局限

固定 Go 1.27.3、`GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0`，使用自生成短音频与临时副本；DFF 另验证了用户提供的真实 DST 样本副本：

| 夹具                                   | 已验证                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| MP3 ID3v2.3 / v2.4                     | 中文标题、独立多艺人数组、专辑、备注、LRC、双 PNG 图片、增大标题、清空/保留、未知 TXXX 与 RawFrame 保留、ffprobe packet SHA256 不变 |
| MP3 v1-only                            | 仅修改多艺人时提升 v2，旧标题/专辑保留，packet SHA256 不变                                                                          |
| FLAC                                   | 同样字段/多值/封面/清空往返，未知 comment 和 APPLICATION block 保留，packet SHA256 不变，16-bit/44100Hz 属性                        |
| WAV、AIFF/AIF、AAC、M4A/MP4、Ogg、WebM | 中文字段、歌词、封面增长/清除，ffprobe packet SHA256 保持；RF64、Ogg Opus 另有专项                                                  |
| APE                                    | 合成 MAC 容器结构与负载校验；没有真实 APE 编码/解码夹具，不能据此声称实机播放通过                                                   |
| 失败                                   | 调用前取消、畸形输入、副本 WriteAt 失败返回错误、原件未变                                                                           |

DFF 另覆盖 DSD/DST 合成结构的标签增长/清空、多艺人、歌词和封面往返、坏帧拒绝，以及真实 DST 样本副本的完整下载和标签写入；写入前后音频负载保持。

fixture 通过测试工具 ffmpeg 自生成，音频 packet 由独立 ffprobe 读取/hash；产品包不执行外部程序。
字段往返主要由 mtag 重开验证，尚未用第二个标签库证明跨播放器多值互操作。
更多容器变体、跨播放器多值互操作、SYLT、多语言歌词、真实 App/UI/播放以及用户音乐库尚未验收。fragmented MP4、chained/multiplexed Ogg、unknown-size Matroska Cluster 等不能可靠校验的布局会拒绝保存并保留原件，详见 [多格式报告](formats-report.md)。

原件替换前的平台属性保留由 files service 实现：macOS 保留既有属性合同；Linux 保留 uid/gid、权限、POSIX access ACL、user xattr 与纳秒时间；Windows 保留 owner/group、DACL/保护状态、mandatory label、四项时间与普通 DOS 属性。Linux 特殊 inode flags/特权模式、Windows ADS/EA 或不可复制存储属性会明确拒绝；Windows 审计 SACL 不在普通用户保留合同内。Linux/Windows 当前仅完成交叉编译和静态检查，尚无实机执行结论。

Windows 保存先同步 work/backup 文件，仍通过 pinned `os.Root.Rename` 替换；不对只读目录句柄执行必然失败的 Sync。平台不能保证断电后的目录项持久性，因此返回 `durability_uncertain`、`Committed=true` 和可用的新 ref/info/hash，并保留恢复副本。恢复副本不会自动删除，也不能声称其目录项已获得断电保证。POSIX 目录 Sync 的真实错误继续透传。

本机测试需要 ffmpeg、ffprobe；缺少 ffmpeg 时夹具测试会 skip，不能据此声称格式验证通过。
可设 `METADATA_FIXTURE_DIR` 为已有 scratch 目录，保留生成夹具及失败副本。

可设 `HE_MUSIC_DFF_SAMPLE` 为本地 DFF 样本路径并运行
`go test ./desktop -run TestNativeDFFSampleFullTransfer -count=1`，验证原样下载和写入标签的完整流程；测试只读样本，产出位于临时目录。

## 依赖集成

主模块现已固定 `github.com/tommyo123/mtag v1.0.2`，对应上述精确提交，实际模块校验值已进入 go.sum。
直接访问官方 proxy/sumdb 的首次失败保留；父随后通过可达的 goproxy.cn 转发，启用
`GOSUMDB=sum.golang.org`，由 Go 1.27.3 下载并校验模块，未在产品中使用本地 replace。
原文件授权写回和 UI 已由 files service 接通；校验使用临时夹具，无产品外部工具运行依赖。具体本轮验证结果记录在 [迁移日志](../../docs/plans/mygo-migration-log.md)。
MIT 许可证仍适用，未复制或更改上游源码。
