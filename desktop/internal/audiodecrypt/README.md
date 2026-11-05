# 客户端音频执行器

`transform/` 同步后端 `srv-he-music/pkg/audio/transform` 的源码与测试，使桌面构建不依赖整个后端模块或本机目录。当前对应后端音频参数 v1 改造；同步时逐文件核对，不再复制原始密钥派生实现。

来源仍为原先固定提交 `1dd6ea1743dcfc6a1ba42ccc559a28ceb41ff2b5`（AGPL-3.0）及后续拆分：

- 流变换执行逻辑来自 `pkg/um/mg`、`pkg/um/qmc`。
- MP4 样本与 HTTP 缓存来自 `pkg/um/soda`，保留 `github.com/guohuiyuan/music-lib/soda/crypto.go` 的来源声明。
- MP4 合成样本、IV、子样本与并发取消回归测试也随执行器迁移。

## 参数与播放

mygo 请求 `/v1/song/url` 时传入 `client_decrypt=true&audio_params_version=1`，后端返回 CDN URL、最终输出格式和 `audio_params`。前端只透传执行材料，本机 URL 为 `__audio?url=...&audio_params=...&format=...`，没有平台选择参数，也不接收原始 key。

`audio_params` 是 Base64URL 编码的版本化 JSON；包含数值操作类型、已准备的字节序列或初始状态，以及可选的媒体 User-Agent。咪咕固定盐/MD5、酷我 V1/V2/TEA 派生和状态初始化、汽水 PlayAuth 提取均由主服务完成。编码不提供保密或访问授权，客户端仍可读取执行材料。

桌面端与用户 API 均直接使用新协议，对外响应不再包含 `key`，平台内部 RPC 仍保留原始密钥供主服务预计算。新桌面端需要支持 v1 的后端。后端直接返回无密钥的服务端解密地址时仍沿用该地址；旧后端若返回原始密钥则明确失败，不保留旧派生算法作为回退。

播放和下载共用 `desktop/gateway_audio.go`，CDN 音频不经过主服务。参数随请求传入受随机前缀保护的本机网关，不注册或持久化音源。流式操作使用实际上游响应偏移；MP4 样本操作先获取完整文件，原地解密后处理 Range。单文件上限 128 MiB，缓存上限 128 MiB、最多一分钟，并限制并发和响应读取者。

桌面端网关（API、媒体和音频）、原生下载及代理连通性测试共用 `desktop/internal/httpclient` 的默认 UA 策略：空缺或空白 User-Agent 使用统一浏览器值，已指定的非空值保持不变。默认值为 `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`。

## 验证与同步

运行 `go test -race ./desktop/internal/audiodecrypt/... ./desktop`，以及音频地址解析和下载相关 Vitest。后端还包含新旧派生/解密结果对照测试，覆盖 V1/V2、Map、分段与跨边界偏移。同步后比较两边执行源码和测试，避免协议漂移。

合成数据验证不能替代真实歌曲及各系统 WebView/原生播放器的播放验收。本次没有进行真实平台联调，也没有更新历史性能基准。
