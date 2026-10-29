# 多格式 metadata 与文件大小限制审计

审计基线：`005a459`；SDK：本地只读 `github.com/tommyo123/mtag@v1.0.2`，固定提交 `57fea0d75b4f88edcdee8ca75e9423d522023f86`。没有网络、依赖变更、真实 App、用户音乐文件或 SDK cache 写入。

父集成状态：本报告所列生产接线已落入主分支工作流，最终无 overlay 验证与限制以 [第十轮迁移日志](../../docs/plans/mygo-migration-log.md#第十轮本地音乐与下载持久化及多格式) 为准。以下保留 leaf 审计与交接过程。

本 leaf 仅新增 `formats.go`、`formats_test.go` 和此报告。下列现有文件由父 owner 修改。本次 leaf 在 `/tmp` Go overlay 中仅将 `supported` 改为 `return nil`，验证接入后的行为；overlay 不修改仓库文件。最终父集成仍需跑无 overlay 的测试。

## 固定 SDK 源码全量容器审计

`container.go` 的 27 个 ContainerKind 均有 detect 和 saveMetadata 分派，不存在此前假设的“AAC 不支持、必须伪装 MP3”。`file_open.go` 的 maxFileSize 默认为 0，只有显式 WithMaxFileSize 才限制整个文件大小。`capabilities.go` 说明各容器的字段能力不同，不能因有 writer 推断所有字段都可写。

| 容器                  | 实际 metadata reader / writer                 | 本次范围                                                        |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| MP3                   | ID3v2/ID3v1/可选 APE；saveMP3                 | 保留既有完整性校验                                              |
| WAV（RIFF/RF64/BW64） | ID3 chunk、RIFF INFO/BWF；saveRIFFContainer   | 开放，新增 fmt/data/fact 校验                                   |
| AIFF/AIFC             | FORM 内 ID3 chunk；saveRIFFContainer          | 开放，新增 COMM/SSND 校验                                       |
| FLAC                  | Vorbis comments/pictures；saveFLAC            | 保留既有完整性校验                                              |
| MP4/M4A               | ilst、mdta、chapters；saveMP4                 | 开放，新增 mdat、解码/时间/sample tables、规范化 stco/co64 校验 |
| OGG                   | Vorbis/Opus/Speex comment；saveOGG            | 开放，新增 packet/CRC/音频页 granule 与完成 packet 序号校验     |
| MAC（.ape）           | native APEv2；saveMAC                         | 开放，新增非标签区域与 descriptor extent 校验                   |
| AAC（raw ADTS）       | 前置 ID3、可选尾部 APE/ID3v1；saveMP3         | 开放，SDK 保持真实 ContainerAAC，逐 ADTS frame 校验             |
| AC3                   | raw ID3/APE；saveMP3                          | SDK 可读写，非本次 payload validator 范围                       |
| DTS                   | raw ID3/APE；saveMP3                          | 同上                                                            |
| AMR                   | raw ID3/APE；saveMP3                          | 同上                                                            |
| WavPack               | native APE；saveMAC                           | 同上                                                            |
| MPC                   | native APE；saveMAC                           | 同上                                                            |
| ASF/WMA               | native objects；saveASF                       | 同上，歌词等能力有区别                                          |
| DSF                   | trailing ID3 pointer；saveDSF                 | 同上                                                            |
| DFF                   | ID3 chunk；saveDFF                            | 同上                                                            |
| Matroska/WebM         | Info/SimpleTag/图片 attachments；saveMatroska | 开放，新增 Tracks/Cluster/TimecodeScale 校验                    |
| TTA                   | raw ID3/APE；saveMP3                          | SDK 可读写，非本次 payload validator 范围                       |
| TAK                   | APE；saveMAC                                  | 同上                                                            |
| W64                   | Wave64 summary/ID3；saveW64Container          | 同上                                                            |
| MOD                   | native title；saveTracker                     | 同上，非所有字段/模块变体都可写                                 |
| S3M                   | native title；saveTracker                     | 同上                                                            |
| XM                    | native title；saveTracker                     | 同上                                                            |
| IT                    | native title；saveTracker                     | 同上                                                            |
| RealMedia             | native text objects；saveRealMedia            | 同上，字段能力受限                                              |
| CAF                   | info chunks；saveCAF                          | 同上，字段能力受限                                              |
| OMA                   | OpenMG/ID3；saveOMA                           | 同上                                                            |

主要源码依据：`container.go:12` 枚举，`:163` magic detection（包括 ID3 后再次识别 ADTS），`:433` 起全部 writer 分派；`file_fields.go`、`file_text.go` 字段映射；`file_images.go` 图片；`save_ogg.go` 重分页；`save_matroska.go` 保留 Cluster/Tracks 原 bytes。27 种以外 unknown magic 会 fallback bare-MP3，不能将该 fallback 当成实际媒体真实性证明。最终保存必须经过独立 payload validator。

SDK 对单个标签/图片/Matroska element/Ogg packet 仍有内存保护，这与整首音频文件大小限制不同；没有修改 SDK 或取消这些保护。

## 新增 helper 合同

```go
func CompareFormatAudioPayload(ctx context.Context, left io.ReaderAt, leftSize int64, right io.ReaderAt, rightSize int64) error
```

仅比较用户新增容器的 encoded media 和必要解码配置；无路径权限、无写权限、无 ffmpeg 运行依赖。Reader 必须在整个调用期间保持不变。使用 32KiB buffer 流式 SHA256，文件大小无人工上限；MP4 另缓存按文件位置排序的 mdat 范围，内存仅随 mdat 数增长，不随文本标签长度、媒体大小或 chunk 项数增长。取消、越界、截断、错误 framing、非支持布局立即失败；内容不同返回 `ErrAudioPayloadChanged`。MP3/FLAC 留给旧校验器。

MP4 的绝对 chunk offsets 会因 moov 标签增长而改变，故规范化为连续 mdat bodies 内偏移，并验证仍指向 mdat；不能简单忽略 stco/co64。Ogg 会因 comment 增长重分页，因此按 logical packet（跳过已确认的 comment）比对，而非按整个 page bytes。CRC 与每个音频页的有效 granule、该页最后完成的逻辑 packet 序号单独保护；纯 metadata 页排除，无法规范化的 EOS 布局返回 unsupported。WebM 比较完整 Tracks 与 Cluster bytes，同时保护 TimecodeScale；不把图片 attachment 混入媒体 hash。

边界：fragmented MP4、chained/multiplexed Ogg、未知大小的 Matroska Cluster、RF64 ds64 扩展表、部分旧/未来 MAC 布局会明确 unsupported/invalid。普通已验证变体有实际读写路径，绝非全部 unsupported。该校验不提供新 decoder，不能证明任意原始输入可被系统 codec 播放。扫描必须允许解析失败时以文件名收录，播放独立于标签读取。

## 父 owner 精确替换候选

### desktop/metadata/metadata.go

原：

```go
var ErrUnsupportedContainer = errors.New("metadata: only MP3 and FLAC are validated")
```

新：

```go
var ErrUnsupportedContainer = errors.New("metadata: unsupported container")
```

原：

```go
func supported(f *mtag.File) error {
	if f.Container() != mtag.ContainerMP3 && f.Container() != mtag.ContainerFLAC {
		return fmt.Errorf("%w: %s", ErrUnsupportedContainer, f.Container())
	}
	return nil
}
```

新（最小接入；同时删去未使用 fmt import）：

```go
func supported(f *mtag.File) error {
	if f.Container() == mtag.ContainerUnknown {
		return ErrUnsupportedContainer
	}
	return nil
}
```

native Vorbis 多艺人处理：artistValues/setArtists 中两处原 `if f.Container() == mtag.ContainerFLAC {` 均替换为 `if f.Container() == mtag.ContainerFLAC || f.Container() == mtag.ContainerOGG {`。其它容器至少已有 convenience setter 的真实主艺人保存，不应把 `Artists` 的全部值静默当成已保存；若父要求所有容器数组全量保留，应按 SDK native custom 字段分别扩展，并加多值实测。当前新增 roundtrip 对每类单艺人和独立专辑艺人作精确断言。

### desktop/metadata/payload.go

原：

```go
if s.size <= 0 || s.size > MaxPayloadFileSize {
	return fmt.Errorf("%w: size must be 1..%d", ErrUnsupportedPayload, MaxPayloadFileSize)
}
```

新：

```go
if s.size <= 0 {
	return fmt.Errorf("%w: size must be positive", ErrInvalidPayload)
}
```

删除 `MaxPayloadFileSize` 常量和其“Larger files are refused”注释，更新旧 size-limit test。CompareAudioPayload 最前先识别 MP3/FLAC 路由，保持旧二者严格校验，其余调用本 helper；父应调用下述 `AdditionalPayloadFormat` 小 header 探测，避免仅看 `.aac` 后缀或 `ID3` 魔数就误判为 MP3。禁止用 `ParseScan` 或完整 metadata parser 作 validator 分派（普通文本标签仍会按长度分配）。返回 true 转交 `CompareFormatAudioPayload`，false 保留旧 MP3/FLAC 校验路径；error 直接返回。两个 reader 均独立识别并严格验证，新 helper 的 hash 包含容器种类，跨类型会失败。

### desktop/files_metadata.go

删除 `const metadataMaxBytes int64 = 32 << 20`。

三处替换：

```go
// 原
if info.Size() <= 0 || info.Size() > metadataMaxBytes {
// 新
if info.Size() <= 0 {

// 原
if edited.Size() <= 0 || edited.Size() > metadataMaxBytes {
// 新
if edited.Size() <= 0 {

// 原
if size <= 0 || size > metadataMaxBytes {
// 新
if size <= 0 {
```

分别位于 metadataHash、保存后 edited.Stat、metadataCopy。非法空文件应报告 invalid/payload_rejected，避免仍以 `limit` 暗示文件过大。`errMetadataLimit = errors.New("metadata size limit")` 建议改为 `errors.New("metadata resource limit")`，因为剩余含 patch/cache/jobs/active 的资源限制，不能全部移除。metadataErrorCode 应同时处理 `mtag.ErrContainerWriteUnsupported` 等原生不支持错误为可解释 unsupported，不能报假成功。

### desktop/files_scan.go

删除两常量 `scanMaxFileBytes int64 = 32 << 20`、`scanMaxBytes int64 = 512 << 20`。删除 walk 和 scanFile 两处 file-byte-limit 分支，以及两处 scanMaxBytes-*bytes 的 byte-limit 分支；保留负数 Stat 检查（不再使用 file-byte-limit 文案）。不要仅去掉单文件上限而留下 512MiB 聚合拒绝。`*bytes += before.Size()` 如保留统计，需饱和处理或删除不再使用的计数，避免目录总大小溢出 int64。

parseErr 原分支末尾 `return j.issue(relative, code)` 必须改为记录 issue 后继续注册 filename fallback，不能丢掉支持后缀的文件。原注释“Registration happens only for parsed files”同时更新。

### desktop/files_stream.go

删除 `localAudioMaxBytes int64 = 32 << 20`。原 `if err != nil || stat.Size() <= 0 || stat.Size() > localAudioMaxBytes {` 改为 `if err != nil || stat.Size() <= 0 {`。localAudioMIME 全段需由父独立 MIME/content probe 接管；原 `metadata.ParseScan` + SampleRateHz/Channels 必须成功的前提会阻断标签坏但可播放的文件；原 switch 只有 mp3/flac 也需覆盖所有请求格式。同步删除“same bounded MP3/FLAC parser as scan”注释。

### desktop/files_download.go

删除 `const downloadMaxBytes int64 = 32 << 20`。删除 ContentLength > downloadMaxBytes 分支。

原：

```go
// Read one sentinel byte above the cap, including for unknown Content-Length.
want := int64(len(buf))
if remaining := downloadMaxBytes - out.Received + 1; remaining < want {
	want = remaining
}
n, readErr := resp.Body.Read(buf[:want])
if int64(n) > downloadMaxBytes-out.Received {
	out.Code = "limit"
	return
}
```

新：

```go
n, readErr := resp.Body.Read(buf)
```

剩余固定 buffer、取消、短写、磁盘错误、负长度/计数溢出检查仍需要。safe filename 原 `return ext == ".mp3" || ext == ".flac"` 改调父统一后缀表。原 `if (info.Container != "mp3" && info.Container != "flac") || "."+info.Container != strings.ToLower(path.Ext(out.Filename)) {` 改调父真实容器/后缀映射（m4a=mp4、aif=aiff、ape=mac、webm=matroska），不能简单 `"."+Container`。随后同文件 CompareAudioPayload 将使用新增 validator；合法未覆盖变体的下载策略由父统一处理，不能伪标 mp3。

### 旧 Electron

`electron/main/ipc/ipc-file.ts` 扫描 `/\.(mp3|wav|flac|aac|m4a|ogg|aiff|ape)$/i` 改为 `/\.(mp3|wav|flac|aac|webm|m4a|mp4|ogg|aiff|aif|ape)$/i`；原单项 catch 的 `return null` 改为 filename fallback 仍收录。`electron/main/utils/helper.ts`/ipc-file.ts 没有整首文件 byte cap，但 getFileMD5 当前 readFile 整首进内存，是大文件内存风险，建议父按流 hash（不是去掉不存在的 cap）。File.createFromPath 的真实格式限制及错误必须向用户保留，不能伪标容器；系统解码器失败也要如实报错。

### 限制错误/文档同步清单

- 删除扫描 `file-byte-limit`、`byte-limit` 的过时路径及对应测试断言。
- metadataTest 的大文件 `limit` 断言改为稀疏样本无文件大小拒绝；保留 jobs/cache/patch 资源 limit 测试。
- metadata/metadata_test.go `TestMetadataUnsupportedAndCancelled` 对 m4a/ogg 的 unsupported 断言必须更新，保留取消/坏数据断言。
- payload_test.go 的 `MaxPayloadFileSize` 上界断言更新。
- files_download_test.go oversized-length/chunked 项改验收大文件可流式下载；safe filename 中 `a.ogg` 不再非法。
- metadata/README.md “其他容器返回 ErrUnsupportedContainer”及“限制资源大小”需区分资源与整首音频。
- metadata/README-extra.md ReadMetadata 的“32MiB 上限”与旧“大小限制”验收描述需同步。
- desktop/downloads-extra.md “流式 32MiB 硬限”“安全单层 MP3/FLAC basename”需同步。
- files_io.go 的 settingsMaxBytes、files_settings.go、gateway API body 32MiB、HTTP header limits、封面/patch/cache/jobs/并发限制不是整首音频上限，保留。不要将错误字符串中所有 limit 盲目删除。

## 验证证据

环境：Go 1.27.3；`PATH=/Users/wangjian/.govm/.install/1.27.3/go/bin:/opt/homebrew/bin:/usr/bin:/bin GOTOOLCHAIN=local GOWORK=off CGO_ENABLED=0 GOPROXY=off GOSUMDB=off`；所有 Go 命令 `-mod=readonly`。

本 leaf 执行：

```sh
go test -mod=readonly -overlay=/tmp/hemusic-formats-overlay.json ./desktop/metadata -run '^TestFormats' -count=1 -v
go vet -mod=readonly -overlay=/tmp/hemusic-formats-overlay.json ./desktop/metadata
go test -mod=readonly ./desktop/metadata -run '^TestFormats(MalformedAndCancelled|PayloadChangesRejected|MP4OffsetChangeRejected)$' -count=1 -v
```

- WAV、AAC/ADTS、WebM/Opus、M4A/AAC（faststart）、MP4/AAC（faststart）、Ogg/Vorbis、AIFF、AIF：全部为 ffmpeg lavfi 临时正弦合成，中文 title/artist/album/albumartist/comment/lyrics/PNG cover 精确 roundtrip；再次增长到长标题，再清除 lyrics/cover；独立 ffprobe 每 encoded audio packet SHA256 前后相同，新 validator 同时通过。
- RF64 WAV、Ogg Opus 单独实际合成，标签和图片/歌词保存后逐包 hash 相同。
- WAV/AAC/WebM/MP4/Ogg/AIFF 媒体字节篡改拒绝；MP4 sample offset 单字节篡改拒绝；上述格式截断拒绝；预取消在 IO 前返回。
- 33MiB 稀疏 WAV reader：ParseScan 和完整性比较通过；最大单次 read 32768 bytes，主体按需生成，不分配整文件或 GB 内存。
- APE：本机 ffmpeg 无 APE encoder、无 mac 命令。测试仅自行构造 MAC descriptor/header/seek table + 明确不声称可解码的 opaque frame bytes，验证真实 APEv2 标签 read/write、封面、歌词、音频区域保留与篡改拒绝。没有使用 SDK 的真实音频 fixture。不能把结构测试外推为实际 APE 编码/解码测试。
- 上述最终检查均通过；首次无 overlay 的完整新增测试因父白名单尚未接入而失败，不能报告当前仓库完整集成已通过。首次 WebM ffprobe CombinedOutput 混入 stderr 的测试问题已通过只解析 stdout 修正；长标题改为不带末尾空格，避免 SDK 正常 trim 造成错误断言。
- 没有真实 App、系统播放、UI、网络或用户文件验证。文件允许扫描/发放播放 URL 不保证系统 codec 能解码；需要展示真实失败。

## 独立 review 修复（本轮）

仅修改本 leaf 原先新增的三个文件；没有修改 `payload.go`、`metadata.go`、SDK、依赖缓存或父主树。

新增导出合同：

```go
func AdditionalPayloadFormat(ctx context.Context, r io.ReaderAt, size int64) (bool, error)
```

它只经 `payloadSource.read` 读取至多 12-byte 起始 header；前置 ID3 按 syncsafe 宣告长度及 v2.4 footer 跳过，然后再读 2-byte ADTS signature。最多两次小读取，不解析/分配 tag body，支持任意合法文件大小。MP3、FLAC、unknown 返回 false；被截断或长度非法的 ID3 返回 error。探测成功只选择 validator，真正结构合法性由对应 validator 决定。预取消与读取中取消均返回 context 错误；不触发原始 reader 的无 context ParseScan。

Ogg：在每页已完成的音频 packet 中记录最后一个逻辑序号（Vorbis 排除 identification/comment/setup，Opus/Speex 排除前两个 header），将该序号与有效 granule 纳入 hash。纯 metadata 页不进入时间定位 hash，CRC、packet framing 和单逻辑流检查保留。无可用音频定位的 EOS 明确 unsupported。

MP4：在遍历 sample table 前仅扫描一次顶层 atoms，缓存 mdat 的 `[body,end)` 与累计媒体基址；每个 stco/co64 项二分查询区间，保留严格边界、无符号 64-bit offset、完整 table extent 校验。时间读取量从 chunk×atom 改为 atom+chunk，查找 CPU 为 chunk×log(mdat)。索引内存 O(mdat)，没有为 chunk 或文本标签建表。

### 先红后绿与验证

固定 Go 环境与上节一致。无 overlay 的确定性回归命令：

```sh
go test -mod=readonly ./desktop/metadata -run '^TestFormats(OggNonEOSGranuleRejected|MP4ChunkOffsetReadWork)$' -count=1 -v
```

先红：真实 ffmpeg 合成的 Opus、Vorbis 都在非 EOS 音频页 granule+1 并重算正确 CRC 后错误返回 nil（测试还验证被改文件与自身比较成功，排除结构损坏造成假阳性）；512 个 chunk+512 个空 free atom 发生 528404 次、4224144 bytes 读取，超出线性工作量断言。最初尝试 libvorbis encoder 不存在，已改为本机可用的原生 vorbis，后续两个 codec 均实际复现并通过修复测试。

后绿：同命令两 codec 均正确返回 ErrAudioPayloadChanged；MP4 读取降至 3098 次、21696 bytes。工作量测试以 countReader 记录请求次数/字节，不使用 walltime。

最终实际通过：

```sh
go test -mod=readonly -overlay=/tmp/hemusic-formats-overlay.json ./desktop/metadata -run '^TestFormats' -count=1
go test -mod=readonly ./desktop/metadata -run '^TestFormats(OggNonEOSGranuleRejected|MP4ChunkOffsetReadWork|AdditionalPayloadFormatProbe|MP4MediaIndexBoundaries|DifferentContainersRejected|OggCommentRepagination|MalformedAndCancelled|PayloadChangesRejected|MP4OffsetChangeRejected)$' -count=1 -v
go vet -mod=readonly -overlay=/tmp/hemusic-formats-overlay.json ./desktop/metadata
git diff --check
```

overlay 沿用上轮，只替换 metadata.go 的 supported 为 return nil 并移除因此未使用的 fmt import；仓库 baseline 未改。全套新增 TestFormats 在 overlay 下通过，父集成后仍需无 overlay 完整验证。

新增额外证据：128MiB 稀疏 ID3（带/不带 footer）只作两次小读取即可区分 ADTS/MP3；1TiB 宣告 MP4 只读一次 header；body 读取会被测试 reader 直接拒绝。覆盖未知格式/MP3/FLAC false、非法 ID3、预取消和读取中取消、不同容器拒绝；stco/co64 多 mdat 的重定位、乱序 offset、header/gap/末尾越界及 64-bit 溢出；正确 continuation flag 的跨页 comment 改写通过，音频页 granule 改写失败。

边界发现：临时把真实 Vorbis title 增至约 200KB 时，固定 SDK 输出 comment 连续 255-lace 页，但后页 continuation flag 仍为 0（实测 flags=0）；严格 framing 校验拒绝该输出。这是 SDK writer 既有边界，不放松 validator，也不改 SDK。临时调试与该试验已移除；结构正确的跨页 comment 夹具已单独保留。未声称此超长标签 writer 路径通过。无网络、真实 App、用户音乐库或依赖 cache 写入。
