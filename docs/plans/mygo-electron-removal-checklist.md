# Electron 待移除范围与服务去向

本文是删除前的审查清单。当前 Electron 源码、依赖、入口和条件分支全部保留；实际移除须得到用户最终确认。本文不表示已完成 Windows 实机、系统音频、普通安装流程或更新发布验收。

## 服务去向

| 旧入口                                                    | mygo / Web 的实际去向                                                                                                                            | 移除时的边界                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/server/index.ts` 的 Fastify 总服务与静态文件    | mygo 使用嵌入前端及 Go 服务，Web 使用 `dist/web` 独立部署                                                                                        | 不引入 Node sidecar；保留独立 Web 构建                                                                                                                                     |
| `electron/server/netease/index.ts` 的网易路由             | 配置 `VITE_NETEASE_API_URL`；相对 `/api/netease` 通过 HE-Music 后端提供。mygo 的 Go gateway 转发配置的固定 API 路由                              | 不把 npm 网易 API 实现搬进 Go，不把 HTTP 控制端口当成音乐后端                                                                                                              |
| `electron/server/unblock/` 的网易、酷我、波点、歌曲宝解灰 | `src/api/song.ts` 的 `/api/unblock` 请求由外部 HE-Music 后端提供；mygo gateway 使用后端的对应固定路由                                            | 不在客户端重新实现这些第三方服务                                                                                                                                           |
| Electron 专用 `/lyric/ttml`                               | Web/mygo 沿用直接读取 TTML 数据库的分支；mygo 通过现有资源 gateway 处理远程资源                                                                  | 保留 TTML 与现有歌词数据、效果及布局实现                                                                                                                                   |
| `electron/server/login/index.ts` 的 `/login/success`      | `desktop/auth.go` 预留独立 loopback listener，前端将返回的 callback URL 交给 HE-Music `/v1/auth/session`；state 事件返回发起页，再由后端兑换结果 | `prepare(0)` 由系统分配端口，避免与长驻控制服务争用 25666；保留 owner/session/state/期限与消费保护                                                                         |
| `electron/server/control/index.ts`                        | `desktop/control_http.go`、`control_runtime.go` → `ControlSession` → `shellControl` → 现有 Player                                                | 保留六条 GET `/api/control/{play,pause,toggle,next,prev,status}`、响应 envelope 与可配置端口；默认 25666、仅 loopback。HTTP 200 表示命令已发出，receipt 不证明扬声器已发声 |
| Electron 文件、标签、下载 IPC                             | `NativeFiles`、grant/ref/epoch、流式播放、metadata 保存事务与下载事务                                                                            | 不保存运行时授权到历史，不因清理失败丢失已提交状态，不自动覆盖重试                                                                                                         |
| Electron 更新与安装                                       | mygo updater provider、签名清单与发布检查脚本                                                                                                    | feed、公钥和 CI 私钥尚未配置；不能称已具备可发布更新源                                                                                                                     |

当前 `.env.example` 中 `VITE_API_URL` 为占位地址，需由部署方提供实际后端；开发工具 Node 仍用于 pnpm/Vite，产品运行时不依赖 Node。`VITE_SERVER_PORT` 只控制本地播放控制服务，mygo OAuth 不再要求占用该固定端口。

## 确认后可移除的专用文件

`electron/` 当前有 47 个 Git 跟踪文件，删除范围为整个目录，包含：

- `main/index.ts`、`main/index.d.ts`，以及 `main/i18n/`、`ipc/`、`logger/`、`shortcut/`、`store/`、`thumbar/`、`tray/`、`update/`、`utils/`、`windows/`。
- `preload/index.ts`、`preload/index.d.ts`。
- `server/index.ts`、`index.test.ts`、`port.ts`，以及 `server/control/`、`login/`、`netease/`、`unblock/`。

以下根文件也是专用删除候选：

- `electron-builder.config.ts`。
- `electron.vite.config.ts`。
- `dev-app-update.yml`。
- `scripts/dev.mjs`（当前仅启动 electron-vite）。

图标、字体、版权、许可证、歌词实现和其他公用资源不因位于旧配置引用路径而删除。`assets.go` 仍嵌入 `public/icons/tray/`，这些图标必须保留。

## 需配套修改，不能只删文件

1. `src/platform/electron.ts`、`electronShortcuts.ts`、宿主选择器及 Electron 专用测试：在移除 adapter 前清理导入和对应分支，保留 Web/mygo 的 capability 路径。
2. `src/utils/initIpc.ts`、初始化流程，以及共享 Vue、组合式函数、设置、文件弹窗、播放器中的 `isElectron` / `window.electron` 分支：按功能移除旧实现，保留已接入的 mygo 和 Web 逻辑。不能以全局文本替换改变播放或歌词行为。
3. `tsconfig.web.json` 当前仍 extends `@electron-toolkit/tsconfig`，并包含 Electron/preload 声明及 `electron`、`electron-vite/node` types。先换成独立配置并清理共享类型，再删除相应依赖。
4. `tsconfig.node.json` 当前专用于 Electron 源码。独立 Vite 配置检查沿用 `tsconfig.vite.json`；重新安排 `typecheck:node` / `typecheck`，保留构建工具的 Node 类型。
5. `package.json` 的 `main`、`start`、`dev`、默认 `build`、`install:electron-deps`、`build:unpack`、旧 `build:win/mac/linux`：改为明确的 mygo/Web 入口，不留指向已删除文件的默认命令。
6. `.github/workflows/release.yml` 当前为 Electron 构建与发布流程，必须替换为已验证的 mygo 打包及独立 Web 构建。发布签名与更新源缺失时应明确失败，不能填假密钥或伪造发布条件。
7. README、开发指南和打包文档：更新命令、平台运行要求和能力限制，保留迁移记录中的历史验证事实。
8. 最后由 pnpm 更新 lockfile，重新进行无 Electron 依赖的安装、类型检查、测试、Web/desktop 构建及产物审计；本轮仍保留 Electron 的检查不能代替删除后的验收。

## 依赖清理候选

确认移除所有专用引用后，再移除以下直接依赖并由 pnpm 重算传递依赖：

- `electron`、`electron-vite`、`electron-builder`、`electron-log`。
- `@electron-toolkit/preload`、`@electron-toolkit/utils`、`@electron-toolkit/tsconfig`。
- `electron-dl`、`electron-store`、`electron-updater`、`font-list`、`node-taglib-sharp`。
- `@neteasecloudmusicapienhanced/api`、`get-port`、`change-case`。
- 旧服务专用 `fastify`、`@fastify/cookie`、`@fastify/http-proxy`、`@fastify/multipart`、`@fastify/static`；先随旧服务测试一同核对，不能仅按包名判断公用依赖。

`file-saver`、`md5`、Axios、Vue、Pinia、歌词库、媒体与图像库、Node 开发类型和 Vite 插件不列入整包删除范围；需要根据保留的 Web/业务引用分别处理。

## 验证范围与限制

- 本轮用真实生产路径的 CPU SFC/Player/Driver 测试、Go 测试、静态构建、交叉编译与 Podman Linux 执行验证。没有启动或操作用户 App、真实音乐库、系统音频设备或真实认证 API。
- Linux 验证会记录冻结提交、Go/CGO/文件系统/ffmpeg/fontconfig 环境与跳过事件；不能用作者候选或旧冻结结果替代新的生产快照。
- Windows 的 amd64/arm64 编译与 vet 不等于 NTFS、WebView2、快捷键、托盘或安装程序已实机运行。
- 下载开放 11 个后缀，不表示任意容器布局和标签组合都能写入。WebM/M4A/MP4/APE 的本轮组合可返回 `unsupported` 并保留原文件；APE 结构夹具不等于真实编码/解码兼容验收。
- 实际删除前需再次检查差异并取得用户确认；实际删除后还需重新验收，不能沿用本清单作为完成证明。
