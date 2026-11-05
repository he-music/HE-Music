# 客户端音频解密

本目录复用 `srv-he-music` 的解密实现，来源提交为
`1dd6ea1743dcfc6a1ba42ccc559a28ceb41ff2b5`（AGPL-3.0）：

- `qmc/`：`pkg/um/qmc/`，用于酷我。
- `mg/decoder.go`：`pkg/um/mg/decoder.go`，用于咪咕。
- `soda/`：`pkg/um/soda/{crypto,http}.go`，用于汽水；保留原有来源声明。
- 汽水合成 MP4 测试来自同一提交的 `pkg/um/soda/crypto_test.go`。

使用固定源码快照，使桌面构建不依赖后端整个服务模块或本机目录。
同步算法时对照上述源文件，保留版权声明，并运行本目录和网关的回归测试。
`qmc/decoder.go` 省略了上游未启用的注释代码。
汽水同步了本次后端优化：新增 `DecryptAudioInPlace`、先验证全部样本边界、
集中存储 16 字节 IV，并在 HTTP 下载链路复用独占缓冲区。

播放和下载共用 `desktop/gateway_audio.go`。解密参数随请求传入本机网关，
不注册音源，也不持久化音频 URL 或密钥。酷我和咪咕按实际响应偏移流式解密；
汽水先获取完整 MP4，再解密并处理 Range，单文件上限 128 MiB，
解密缓存上限 128 MiB、有效期最多一分钟，并限制并发。

后端 `/v1/song/url` 需支持 `client_decrypt=true`。mygo 默认传入，
网页不传，后端默认逻辑保持不变。已有后端如果仍返回解密服务器地址且不带密钥，
客户端沿用该地址。

汽水目前以合成加密 MP4 验证算法、HEAD、Range 和错误处理，
尚未验证真实歌曲与各系统 WebView 的实际播放。

性能基准使用 Go 1.27.3、Apple M2 Pro、8192 个独立 IV 的 2048 字节样本，
共约 16 MiB。运行 `go test -run '^$' -bench BenchmarkDecryptAudio -benchmem
-benchtime=200ms -count=3 ./pkg/um/soda`；不包含网络、磁盘和播放耗时。

| 指标           | 优化前复制接口 | 优化后原地接口 |
| -------------- | -------------- | -------------- |
| 三轮耗时中位数 | 3.83 ms        | 2.42 ms        |
| 每次额外分配   | 21.7 MB        | 4.6 MB         |
| 每次分配次数   | 24598          | 8213           |

额外分配是基准的 `B/op`，不等同于进程峰值内存。原地接口只用于独占的
下载缓冲区；已有 `DecryptAudio` 和 WASM 入口仍保留不修改输入的行为。
