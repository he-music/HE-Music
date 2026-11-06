# libmpv 资源交付检查点

日期：2026-11-06。**精简运行包 v0.42.0-2 已发布并接入**。HE-Music 的 `mpv` 目录仅保存实际动态库；源码、构建配置和重建脚本在同版本独立材料包中。macOS universal 应用由 111.18 MiB 降至 65.58 MiB。

## 当前精简交付

- 正式版本：[v0.42.0-2](https://github.com/he-music/mpv-bundles/releases/tag/v0.42.0-2)，[重组 CI 42188689472](https://github.com/he-music/mpv-bundles/actions/runs/42188689472) 通过。复用 v1 已通过原生测试的库，五平台二进制逐字节相同；不把重组当成重新编译或原生执行。
- 八个实包与本地确定性重组及 GitHub API 大小/SHA256 一致。运行包约 5.5–11 MB；单一材料包 72,649,121 字节，14 份源码去重，保留配置、补丁、重建与链接证据，省略冗长日志。
- HE 从公开地址实际下载并校验五份运行归档。默认不下载材料包；cache 中只有五个运行归档。schema 2 锁中的 `runtimeFiles`、`licenseFiles` 直接固定安装文件摘要，无需把 manifest 复制进应用。
- `resources/darwin-universal/mpv` 和新 App 包内 `mpv` 都只有 `libmpv.2.dylib`。Windows 安装主 DLL 与必要的 `libiconv-2.dll`；Linux 安装对应 `.so`。许可证集中到旁边的 `licenses/mpv`，保留来源指引。
- 新产物：`build/mygo/mpv-slim-v2/darwin-universal/HE-Music.app`，68,764,934 字节（65.58 MiB），比 v1 的 116,575,985 字节减少 47,811,051 字节（约 41%）。未采用 UPX；现有 Go 构建已使用 `-s -w`、`-trimpath`。
- 双架构宿主与 ad hoc 签名完成，`codesign --verify --deep --strict` 通过。包内纯库目录与许可证逐文件校验通过；生产网关 WAV/DSF/DFF/WebM Go race 和私有 DST 压缩 DFF 控制回归通过，均为 `ao=null`，未启动用户 App。
- 62 Python + 3 Node 资源测试、compileall、Prettier、actionlint、差异检查通过。无缓存离线 check 和复用前后库/许可文件的 inode、mtime、大小完全不变。增加了安装选择、许可分离、完整锁校验与失败回滚回归；独立审查指出的 v1/v2 CI 许可归档兼容问题已修复并复核。
- 消费脚本清理后，移除旧源码构建、源码锁、Windows 历史配置和重复库级 smoke runner；Go 网关合成样本保留为 `audio_fixtures.py`。Linux 最终包审计复用下载器校验纯库目录与许可证，仍检查宿主和库的 ELF 需求。当前资源回归为 45 Python + 3 Node，通过；减少的是已由产物仓库负责的旧构建测试。

以下保留 v1 构建与来源材料的历史证据。

## 固定发布

- 产物仓库：[he-music/mpv-bundles](https://github.com/he-music/mpv-bundles)。正式版本：[v0.42.0-1](https://github.com/he-music/mpv-bundles/releases/tag/v0.42.0-1)。发布提交：`80b1ea3962100c4c1440517b16b6704c7aba6224`。
- [CI 42180144126](https://github.com/he-music/mpv-bundles/actions/runs/42180144126) 的五个原生目标及发行索引全部通过。每目标执行实际编译、库加载、WAV/DSF/原始 DFF 控制和 DST 原始帧封装入口测试。macOS universal 在 Intel runner 执行，又在本机 arm64 加载正式库回归。
- mpv 0.42.0、FFmpeg 8.0.1、client API 2.6。统一核心配方 SHA256：`25f8655011fcf7d534e6d06816d07d29a09c1396ce491b52a2fdcbe557f4bb6a`。显式包含 FFmpeg `dst` decoder，构建后硬检查其配置。
- 五份归档以 `mpv/` 为根，携带库、依赖、逐文件清单、原始对应源码、许可证、配置及重建脚本；二进制仅在 Release，不在 Git。
- 发布清单 SHA256：`ce0842745e6cd77af959f6cc5127d1cb09f5439a84b1520276b8af322954b346`。七个 GitHub asset 的大小与 API 摘要均与实包一致；`SHA256SUMS` 覆盖五归档与发布清单。

| 目标             | 归档字节数 | 归档 SHA256                                                        |
| ---------------- | ---------: | ------------------------------------------------------------------ |
| darwin/universal |   57361775 | `a33c04bb257863226ce9423068ee0f5b79956d0784a426ee8c7901c56ad245b1` |
| windows/amd64    |   78876074 | `a3959321321548bb5087c091677a387ffe1de3c3b80123de8c086d999b17f160` |
| windows/arm64    |   78663851 | `c08c7adf3be774e4a13cd507d68d07fbde0840447b5eee583e72bc000532dd45` |
| linux/amd64      |   51781792 | `7a4954ccfb71b34e80940aa468bd754174c15e7443a2034149deff04ee289255` |
| linux/arm64      |   51866009 | `e54410b06b250d4524f624778bbcd34be591d1f210d8d18c141aff61b34de64d` |

## 材料与平台闭包

- Windows 两架构各有 261 项最终链接器实际读取输入，逐项核对原文件字节、pacman owner 和固定版本。`--reproduce` 清单与 map 的 SHA256 绑定随包保存；不以匿名 archive member 名推断归属，也不声称每个成员都被选入最终代码。
- 实际非系统运行 DLL 为 `libiconv-2.dll`。固定 libiconv、完整 MinGW 源树和 MSYS2 配方/补丁原始归档均核过大小/SHA256；工具链许可证、版本和重建指引随包。两架构状态均为 `project-fixed-sources-and-windows-runtime-materials`，详见 [产物仓库的许可材料说明](https://github.com/he-music/mpv-bundles/blob/main/LICENSES.md)。
- macOS 实际 Mach-O 双架构、系统/相对依赖均核对。不同宿主的 `otool` 可能重复列出两个 slice；按依赖集合对照一致。Linux 原生容器审计 ELF、依赖、RPATH/RUNPATH 和 GLIBC 2.35 上限；这不等于整个 HE-Music 宿主的最低系统声明。
- Windows checkout 的 CRLF 曾造成跨平台配方摘要不同，已通过 `.gitattributes` 固定 LF，并在真实 Windows 产物中核对摘要与脚本字节一致。

## HE-Music 消费验证

- `bundles.lock.json` 是实际发布清单，包含归档大小/SHA256、包内清单原始字节 SHA256、库名和固定 URL。公共 `manifest.json` 与本地锁逐字节相同。
- `resources.mjs`、`mpv:prepare`/`mpv:check`、dev/build 和 Release CI 使用 `download.py`。常规消费无需源码构建工具；不向资源子进程传发布私钥，不注入旧构建工具 PATH。源码构建与库级验证由独立产物仓库维护。
- 通过公开 Release 地址实际下载五目标，全部校验归档、内部文件清单和原生文件头/架构；没有在本机执行 Windows/Linux 库。
- macOS universal 已从正式缓存安装。无归档缓存的离线 `--check` 通过；离线复用前后全部 staging 文件/目录的 inode、mtime、大小不变，未创建测试缓存目录。
- Node 24.22.1 下 51 Python + 3 Node 资源测试、24 Release 测试、8 vendor 测试通过；指定 ESLint、Prettier 和 workflow actionlint 通过。消费接线的独立只读审查无问题。

## 本机实际应用产物

- `build/mygo/mpv-bundle-v1/darwin-universal/HE-Music.app` 已构建，mygo 报告 111.2 MB。本次重新执行前端 typecheck/Vite 构建，再编译双架构宿主、合并和 ad hoc 签名；`codesign --verify --deep --strict` 通过。
- 本机遗留的单架构资源目录只有 Finder 元数据；保留现有文件并补齐另一空架构目录后，mygo 成对资源检查通过。未更改 SDK 或删除无关文件。
- 包内 manifest、逐文件清单和架构验证通过。包内/正式 staging 库 SHA256：`9784f8ed8b2cca91f5c3d1ff05ff767ac301db4df9cbeba2a24d67c4e78c7855`。
- 指定包内正式库运行 `TestMpvBundled` 和 `TestMpvDemuxerRejectsSecondaryResources` 的 Go race 回归通过，覆盖生产初始化/Load/受控网关的 WAV/DSF/DFF/WebM、播放、暂停、seek、释放。
- 显式提供的本机 DST 压缩 DFF 对正式库及包内库均通过，codec 为 `dst`，进度、暂停、seek、继续正常；未复制或上传样本。记录位于忽略目录 `build/mpv-bundles/final-package-dst.json`，产物仓库另有 `build/release-v1-private-dst-regression.json`。

## 验收边界与历史记录

- CI 的 DST 自动化样本使用 DST 包内原始帧，不覆盖算术压缩；本机私有压缩样本补充这一回归，不能外推 Windows/Linux 全部压缩变种。
- 没有真实 APE 样本通过声明。未启动/附着/停止用户 App、访问账号或扫描曲库。本次没有进行真实设备热插拔、歌词界面、系统媒体或 Windows 文件占用验收。
- 本次没有生成 DMG、公证或签名更新包，也没有宣称 Windows/Linux HE-Music 安装器通过。不同 SDK/工具链环境不承诺逐字节相同产物。
- 前一阶段应用/播放器实现、188 文件/1649 用例、Go 静态检查及旧包记录见 [引擎方案](../../docs/plans/mygo-mpv-engine.md) 和其原生/UI 检查点。旧官方 Windows DLL 仅作历史来源调查，不参与正式分发。
- 产物仓库的中文提交已推送；HE-Music 提交按 mpv 功能范围整理，下载缓存、二进制和应用产物不入 Git。
