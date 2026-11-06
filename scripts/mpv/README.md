# 随包 libmpv 资源

HE-Music 从 [he-music/mpv-bundles](https://github.com/he-music/mpv-bundles) 的固定版本
GitHub Release 下载资源。开发、打包与 CI 复用 `scripts/mpv/resources.mjs` 入口，通过
Python 标准库校验和安装，无需为 libmpv 安装 C/C++ 编译器、Meson、Ninja、MSYS2 或 gh。
库只从 `mygo.PathResources/mpv` 加载，用户无需另外安装 mpv。

## 固定版本与验证

`scripts/mpv/bundles.lock.json` 固定发行版本、mpv／FFmpeg 版本、client API、配方摘要及
五个平台的归档 URL、大小、SHA256、包内清单 SHA256、主库名称，以及安装库文件和许可证各自的 SHA256/大小。普通准备不会查询 latest。

下载器先核对整个归档，再校验包内清单的原始字节摘要、所有文件的大小与 SHA256，并检查
Mach-O／PE／ELF 架构。清单摘要由本地锁固定，因此同时修改文件和包内清单也无法通过。
解包拒绝越界路径、重复名称、链接与特殊成员；校验成功后才原子替换资源，异常时恢复前次内容。

| 请求目标                                           | 下载目标           | 主库             |
| -------------------------------------------------- | ------------------ | ---------------- |
| `darwin/universal`、`darwin/amd64`、`darwin/arm64` | `darwin/universal` | `libmpv.2.dylib` |
| `windows/amd64`、`windows/arm64`                   | 对应 Windows 架构  | `libmpv-2.dll`   |
| `linux/amd64`、`linux/arm64`                       | 对应 Linux 架构    | `libmpv.so.2`    |

生产者统一从固定源码构建音频配方，包括 APE、DSF、原始 DSD DFF 和 **DST 压缩 DFF**。
Lua 用于保留初始化选项兼容性，实例关闭配置及脚本自动加载。运行归档内保留必要许可证；
完整源码、构建配置及验证证据在同版本的独立材料包中，不进入应用，也不由常规准备步骤下载。

Linux 库基线为 Ubuntu 22.04／glibc 2.35，依赖系统 libstdc++ 和 PulseAudio；这不代表
HE-Music 整体支持 Ubuntu 22.04。应用自身 GTK／WebKitGTK 等依赖仍遵循 mygo 的要求。

## 准备、复用和离线检查

本机需要 Python 3.10+。`MPV_PYTHON` 可指定解释器，`MPV_OFFLINE=1` 禁止联网。

```sh
pnpm mpv:prepare --target darwin/universal
pnpm mpv:check --offline --target darwin/universal
# 只取得并验证归档，不安装 resources。
pnpm mpv:prepare --fetch-only --target windows/amd64,windows/arm64
# 旧资源与新锁不一致时，明确重新取得并安装固定资源。
pnpm mpv:prepare --force --target darwin/universal
```

已安装资源符合锁时直接复用，不重新下载、解包、复制或替换文件。归档缓存不存在时，也能
离线复用或检查已安装资源；若缓存存在，仍会校验其摘要。篡改或过期的缓存、资源会明确失败，
可用 `--force` 从可信来源重新准备。`--offline --force` 需要有效归档缓存。
schema 2 的安装目录不放 manifest，离线检查直接依据版本锁中的 `runtimeFiles` 和 `licenseFiles` 核对文件集合、大小、摘要与架构。

`--check` 不联网、不创建缓存、不修改 staging。显式准备 universal 会清理本工具之前安装的
两个 macOS 单架构 staging，防止 mygo 合并重复资源；检查操作不会清理目录。

```text
build/mpv-bundles/<发行版本>/          校验过的原始归档（忽略）
resources/<GOOS>-<GOARCH>/mpv/         只安装运行库（忽略）
  libmpv.2.dylib | libmpv.so.2 | libmpv-2.dll
  libiconv-2.dll                       Windows 必需依赖
resources/<GOOS>-<GOARCH>/licenses/mpv/ 必要第三方许可和同版本源码材料指引
# manifest、完整源码、配置和重建材料不复制进应用。
```

`--cache` 可指定其他缓存根目录，仍按发行版本隔离。安装临时目录位于资源所在文件系统，
允许缓存放在另一磁盘。逗号目标按顺序准备，每个目标独立回滚。

`sources.lock.json`、`prepare.py` 和 `WINDOWS_SOURCES.md` 保留此前源码构建与调查记录；
正常入口使用 `download.py`，生产者配方在独立分发仓库维护。

## 隔离验证

```sh
pnpm test:desktop:mpv
MPV_INTEGRATION_LIBRARY=/absolute/path/to/libmpv.2.dylib \
  go test ./desktop -run TestMpvBundled -count=1 -v
```

下载器测试只使用临时合成归档和 HTTP mock。原生测试使用 `ao=null`，验证加载、解码和
播放控制，不证明实际声卡播放。生产者另分别记录合成 DST 入口测试与真实压缩样本回归；
合成 DST 原始帧不能替代算术压缩分支的验证。私有音频不进入仓库或发布资源。
