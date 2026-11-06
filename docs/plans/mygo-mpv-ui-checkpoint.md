# mpv UI／播放器集成检查点

本轮接入现有浏览器抽象与原生合同，不启动、附着或停止用户 App，不读取真实曲库／账号，不提交或暂存。既有原生、资源脚本、临时 `.pi/settings.json` 与期间出现的外部网关改动均保留。

## 已实现

- `MpvPlaybackEngine` 使用类型化 provider；先暂停加载，恢复起点／音量／倍速后读取最新播放意图。串行源命令与请求代次阻止过时加载、取消和旧 EOF 复活播放或误触下一首。
- `AudioManager` 等待旧源与实例真实释放后替换引擎，过滤旧实例事件；主 `player` 继续管理队列、歌词、系统媒体与桌面歌词。切换重新解析当前歌曲，暂停状态不偷播，失败保留新设置并停止。
- `MpvPlaybackClock` 使用原生快照和 `performance.now()` 推算，缓冲／暂停冻结、倍速与 seek 由快照重建；高频 getter 不调用 Go。能力单独存放，设置页没有依赖进度或歌词时钟。
- 默认 Web Audio，只有 mygo 展示 mpv。引擎与设备同组，按引擎保存 ID／名称；旧 `playDevice` 仅迁移到浏览器，系统默认在 mpv 映射 `auto`。保留失效设备并提示重选；枚举错误反馈与切换失败不伪装成功。
- mpv 关闭 EQ／频谱／渐入渐出并保留浏览器设置。浏览器原有音源处理准入仍独立保留；频谱按当前引擎和音源能力显示。
- 本地原生音源传当前 `LocalFileRef`／目录 epoch，以歌曲身份校验恢复；网络源继续复用现有网关、鉴权、代理与解密描述。扫描补 `.dsf`／`.dff`；在线 DSD／APE 按引擎筛选，下载格式白名单未扩大。
- 标签保存与目录授权撤销等待 `clearSource` 的完成承诺，再调用原生写入／撤销；释放失败不进入标签写入。Go 原有 mutation hook 继续保护原生读者。

## 验证证据

- Node 24 下 `pnpm typecheck` 通过。
- `pnpm exec vitest run src` 通过，188 个测试文件、1643 项测试；新增与更新测试覆盖时钟、原生快照／缓冲、暂停加载、快速换源、旧事件、输出设备、引擎替换释放、迁移、格式准入、标签与授权释放等待。
- 修改的 TypeScript 文件 ESLint 通过。现有 ESLint 配置忽略 `.vue`，不能把忽略视为组件 lint 通过；Vue 由 typecheck 和前端构建验证。
- `pnpm build:web`、`pnpm build:desktop:frontend` 和全部修改文件 Prettier 检查通过。构建仅产生忽略目录产物。
- `go test ./...` 通过；`go test -race ./desktop -run 'TestMpv|TestScanAudioGlob' -count=1` 通过。Go 修改前读取完整 use-modern-go CLI `list`，只修改扫描 glob 和对应扫描测试，不扩大下载格式。
- 曾运行 `pnpm test`，其 Vitest 默认扫描也包含使用 Node `node:test` 的既有 `scripts/mpv/resources.test.mjs`，报告“无 Vitest suite”；资源测试应按既有 `pnpm test:desktop:mpv` 入口运行。前端源码使用 `vitest run src` 验证，不能宣称默认 `pnpm test` 全部通过。
- 本轮期间外部 `gateway_audio.go/test.go`／`internal/audiodecrypt/transform/` 曾短暂不一致导致 Go 编译失败；按父线程要求完全保留，重新执行 Go 全量已通过。

## 未验收与后续工作

没有新宣称三平台可闻发声、真实设备路由／热插拔、网络实服 Range／过期链接／seek、Windows 文件占用或系统媒体实机通过。既有 macOS 最终包内库的 `ao=null` 证据继续以资源检查点为准。

普通／AMLL／Monet 歌词同步、实际组件更新计数、真实 UI 的暂停切换和设备重连仍须在隔离 App 中验证；本轮没有用静态依赖和 Node 测试代替这些界面验收。原生加载请求的取消通过代次抑制播放，源释放等待当前串行命令结束；慢网络取消延迟也须实测。

Windows 对应源码材料、Linux/Windows 实跑和各平台兼容性缺口见 [资源检查点](../../scripts/mpv/CHECKPOINT.md)。本检查点交付源码与自动化证据，仍需独立 reviewer gate。
