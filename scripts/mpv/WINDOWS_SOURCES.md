# Windows 来源与验收状态

正式资源来自独立产物仓库 [he-music/mpv-bundles](https://github.com/he-music/mpv-bundles) 的 [v0.42.0-2](https://github.com/he-music/mpv-bundles/releases/tag/v0.42.0-2)，由 HE-Music 的 `bundles.lock.json` 固定下载地址、归档大小/SHA256 与包内清单 SHA256。核心配方固定 mpv 0.42.0、FFmpeg 8.0.1 和 client API 2.6，与 macOS/Linux 使用同一份核心源码；HE-Music 的常规构建只下载和校验。

修订 2 仅重组已验证的 v1，库字节不变。HE 的 `mpv` 目录只安装两个 DLL，必要许可证集中保存；源码、配置与重建材料在同版本共享材料包，常规消费不下载。下文原生构建和取证指原始 v1 验证，材料路径以共享包的目标映射为准。

## 已验证的 Windows 产物

- [CI 42180144126](https://github.com/he-music/mpv-bundles/actions/runs/42180144126) 在 `windows-2025 / CLANG64 / amd64` 与 `windows-11-arm / CLANGARM64 / arm64` 完成实际编译、库加载、WAV/DSF/原始 DFF 控制与 DST 原始帧封装入口测试，均为 `ao=null`。
- 两架构均携带 `libmpv-2.dll` 与必要的 `libiconv-2.dll`。普通/延迟 PE 导入、架构和非系统 DLL 闭包已审计；完整归档已按公开下载地址重新下载并逐文件验证。
- 最终 LLD `--reproduce` 实际读取输入已与原文件字节、pacman owner 和固定版本逐项核对，每架构 261 项。记录覆盖实际读取的归档，可能包含未选中的成员；完整 map 用于对照，不据匿名对象名推断来源。两个 JSON 的 SHA256、map 和 reproducer SHA256 绑定保存在 `build-config/`。
- 固定 libiconv `1.19.1-1`，libc++/libunwind/compiler-rt `23.1.5-1`，MinGW CRT/headers/winpthreads `14.0.0.r598.ge3d18511f-1`。运行库许可证及其原始摘要随包保存。
- 包含原始 libiconv 源码、完整固定 MinGW 源树和匹配的 MSYS2 配方/补丁快照；三份归档的大小/SHA256 均已与锁核对。MinGW 材料保守覆盖可能使用的 LGPL headers/runtime；缺少动态 DLL 不表示没有静态代码。
- LLVM 保留 Apache-2.0 WITH LLVM-exception 和历史声明，附匹配配方与重建指引；不声称随包包含整个 LLVM upstream 源树。全部项目库原始源码、许可证、准确命令和配置亦随包。

正式包的 `windows-runtime-review.json` 状态为 `project-fixed-sources-and-windows-runtime-materials`。固定源码镜像见 [sources-v0.42.0-r2](https://github.com/he-music/mpv-bundles/releases/tag/sources-v0.42.0-r2)。重建入口和策略在包内 `rebuild/`，不再使用 HE-Music 历史源码工具作为常规构建入口。

以上证明原生库及材料链路；不代表 HE-Music Windows 安装器、真实输出设备、可闻声音或所有系统版本已验收，也不承诺逐字节可重现构建。下列官方资产调查保留为历史记录，不参与当前正式下载。

## 历史官方资产调查

旧 ZIP 的 URL 和摘要只作为 `historicalWindowsAssets` 留存，不参与正式 prepare/fetch-only。已确认对应关系：

| 目标  | Release asset | 同次 CI artifact | job          | DLL SHA256                                                         |
| ----- | ------------- | ---------------- | ------------ | ------------------------------------------------------------------ |
| amd64 | 711455242     | 13374819743      | 126946096816 | `94fb87247732c59915cd59808bc582e843a71c22214b7b6c1e5563aa8149cef4` |
| arm64 | 711455245     | 13375510941      | 126946096727 | `e2279bc2f05e1a7fb834159ba05527f1cf3d03f66646cbfde50bd1742515a28a` |

- 官方 release：<https://github.com/mpv-player/mpv/releases/tag/v0.42.0>。
- 精确 CI：<https://github.com/mpv-player/mpv/actions/runs/41936479105>，`head_sha=b0841e8c4d156b8403dc1876c4cbd9011eb583f3`。Release ZIP 与同 run artifact 的 size/SHA256 相同。
- 准确配方：该提交的 `.github/workflows/build.yml`、`ci/build-mingw64-full.sh`、`ci/build-common.sh`，均已包含于固定 mpv 归档；其中 LGPL 两目标使用 `ghcr.io/btbn/ffmpeg-builds/win64-lgpl:latest` / `winarm64-lgpl:latest`。
- 两 DLL 的 FFmpeg 标识均为 `git-2026-11-04-baa68e6`，完整提交为 `baa68e68b34e2de912eb7e94342cebd2545f05ed`。固定源码：<https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/baa68e68b34e2de912eb7e94342cebd2545f05ed>。
- 本轮实际下载到忽略缓存 `build/mpv-cache/ffmpeg-upstream-windows-baa68e6.tar.gz`，SHA256 为 `a533cd8e097f2c65e8ebf523ab567817a79ecc9399c5bc5405be0aaf5b79a1f1`。该归档仅是历史官方 DLL 的一层材料，不是项目新配方 FFmpeg 输入。
- 两份实际 DLL configure 字符串已保存于 `upstream-windows/ffmpeg-configure-amd64.txt` 和 `ffmpeg-configure-arm64.txt`。配置中先 enable 后 disable 的项保留原顺序，不能误记最终启用状态。
- 官方 ZIP 另含导入库和两个 libbluray JAR，但没有完整依赖源码或实际配置报告；同 run 的 16 个 artifact 也没有这些材料。
- 历史容器 digest、BtbN recipe commit、活动分支依赖（LuaJIT/libsixel/libarchive/subrandr）、mujs WrapDB 与完整静态依赖闭包仍未恢复。公开 job 日志 API 返回 403，HTML 要求登录，不能据此推断日志本身没有版本记录。

若维护旧 DLL，应取得精确两个 job 的 Initialize containers/Build 日志，绑定容器 digest、导出 `/cross.meson`、FFBUILD 环境及所有源码提交/补丁/配置。不能用今天的 `latest`、同日 BtbN 另一 FFmpeg 二进制或项目 FFmpeg 8.0.1 替代。新配方绕开历史 DLL 的材料依赖，但自身工具链及运行库材料仍须验收。
