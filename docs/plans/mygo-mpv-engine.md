# mygo 可选 mpv 音频引擎设计

状态：浏览器抽象、Go/provider、mpv 主播放器与设置集成已实现，用户已确认 macOS 普通可闻播放。独立 libmpv 五目标原生构建、合成音频控制及本机真实 DST 压缩 DFF 回归已通过；`v0.42.0-2` 已正式发布并接入固定下载，真实设备拔插、三平台安装包及歌词界面仍按下文分别记录验收范围。

## 目标与已确认范围

桌面端增加可手动选择的 mpv 引擎，播放浏览器无法解码的音频。DSD 允许解码为 PCM，目标是正常播放，不要求 DoP 或原生 DSD 输出。

- 浏览器引擎继续作为默认；Web 端保留现有播放方式。
- mygo 支持本地文件和网络音源；mpv 仅负责音频播放，不嵌入视频窗口。
- 不做播放失败后的自动引擎回退。
- 支持播放、暂停、seek、音量、倍速、歌词、切歌和现有系统媒体控制。
- mpv 首期关闭 EQ 和频谱，保留浏览器引擎的相关设置，切回后恢复。
- macOS、Windows、Linux 随安装包提供固定版本的 libmpv 及其依赖，通过 purego 调用，用户无需另装 mpv 或配置 PATH。
- 引擎和输出设备放在同一设置组，设备列表跟随引擎，各引擎分别记忆设备，首次使用系统默认输出。
- 手动切换引擎立即重新加载当前歌曲，尽量恢复原进度和播放／暂停状态，允许短暂中断。
- 切换引擎或设备失败时保留新设置，停止播放并反馈错误，不恢复旧引擎或旧设备继续播放。
- 指定设备被拔掉或下次启动时不存在，暂停并要求重新选择，不自动转到扬声器。
- 借鉴 SPlayer 的 `IPlaybackEngine`，结合 HE-Music 的现有接口、平台边界和状态模型调整。

## 现有架构与参考

HE-Music 当前由 `src/utils/audioManager.ts` 封装 `HTMLAudioElement` 和 Web Audio 图谱，`src/utils/player.ts` 编排队列、音源加载、状态、错误处理、歌词和系统媒体同步。`AudioSourceAccess` 中的 `native` 指普通音频元素路径，不是 Go 原生播放器。

现有依赖为 `github.com/ebitengine/purego`。本次在现有系统库调用基础上增加 `platform.mpvPlayback`，通过生成绑定访问 Go 原生音频服务。

本地歌曲保留绝对路径，浏览器经本机 HTTP 网关播放。在线请求、代理、鉴权及部分音源解密已有网关链路。新增引擎应复用这些处理，避免在 mpv 中另建一套登录、代理或解密逻辑。

SPlayer 参考文件：

- `src/core/audio-player/IPlaybackEngine.ts`：统一播放方法、状态读取和能力声明。
- `src/core/audio-player/MpvPlayer.ts`：将原生事件转换为上层播放语义，首期不提供 EQ 和频谱。
- `src/core/player/AudioManager.ts`：对业务暴露稳定播放入口。
- `src/components/Setting/config/play.ts`：引擎选择和按引擎查询输出设备。
- `electron/main/services/MpvService.ts`：启动系统 mpv，以 socket／命名管道通信；当前每首歌重启进程。

参考的是接口和职责划分。HE-Music 使用随包 libmpv 和 mygo 绑定，不引入 Electron IPC、外部 mpv 命令、终端输出解析或切换引擎后重启应用的流程。引用或移植源码时保留适用的版权与许可证信息。

## 职责与调用链

```text
player
  队列、音源选择、历史、歌词、系统媒体同步
    │
audioManager
  当前引擎、事件转发、引擎切换、能力读取
    │
IPlaybackEngine
    ├─ BrowserPlaybackEngine → 现有 AudioProcessingDriver / AudioOutputRouter
    └─ MpvPlaybackEngine → 平台音频 provider → mygo → Go 音频服务 → libmpv
```

- `player` 继续管理应用队列及自然结束后的下一首。mpv 只管理当前播放项，不开启自己的列表循环或自动下一首。
- `audioManager` 保持对业务的稳定入口，封装引擎替换，避免在页面组件中散布引擎分支。
- 平台音频 provider 负责类型化命令、事件订阅和清理。Web 不直接导入 Go 绑定或原生库。
- Go 音频服务持有 mpv 实例，串行协调命令和销毁。正常切歌使用加载命令复用实例，不逐曲重建。
- 配置 mpv 禁用视频、窗口、OSD、用户配置和无关脚本加载，播放行为由应用管理。
- 系统媒体控制继续经现有控制入口到 `player`；状态与封面继续由应用发布，避免重复维护元数据和播放队列。

## IPlaybackEngine 设计依据

接口已落地于 `src/core/audio-player/IPlaybackEngine.ts`，由浏览器和 mpv 两个实现共同使用。下面保留讨论时的精简草案；实际声明还包含音源描述、会话标识和兼容事件，以生产文件为准。

```ts
export type PlaybackEngineId = "web-audio" | "mpv";

export interface EngineCapabilities {
  readonly supportsRate: boolean;
  readonly supportsSinkId: boolean;
  readonly supportsEqualizer: boolean;
  readonly supportsSpectrum: boolean;
  readonly supportsFade: boolean;
}

export type PlaybackState =
  "idle" | "loading" | "paused" | "playing" | "buffering" | "ended" | "error";

export interface PlayOptions {
  readonly autoPlay?: boolean;
  readonly seek?: number;
  readonly fadeIn?: boolean;
  readonly fadeDuration?: number;
}

export interface PauseOptions {
  readonly fadeOut?: boolean;
  readonly fadeDuration?: number;
}

export interface PlaybackError {
  readonly kind: "source" | "network" | "decode" | "device" | "engine";
  readonly message: string;
}

export interface PlaybackEvent {
  readonly type:
    | "statechange"
    | "timeupdate"
    | "loadedmetadata"
    | "seeked"
    | "ended"
    | "error"
    | "capabilitieschange"
    | "deviceschange";
  readonly sessionId: number;
  readonly error?: PlaybackError;
}

export interface AudioOutputDevice {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

export interface IPlaybackEngine {
  readonly id: PlaybackEngineId;
  readonly capabilities: EngineCapabilities;
  readonly state: PlaybackState;
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly src: string;

  init(): Promise<void>;
  destroy(): Promise<void>;
  play(url?: string, options?: PlayOptions): Promise<void>;
  pause(options?: PauseOptions): Promise<void>;
  stop(): Promise<void>;
  clearSource(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(value: number): Promise<void>;
  getVolume(): number;
  setRate(rate: number): Promise<void>;
  getRate(): number;
  getOutputDevices(): Promise<readonly AudioOutputDevice[]>;
  setSinkId(deviceId: string): Promise<void>;
  onEvent(listener: (event: PlaybackEvent) => void): () => void;

  setFilterGain?(index: number, value: number): void;
  getFilterGains?(): readonly number[];
  getFrequencyData?(): Uint8Array;
}
```

相对 SPlayer 的调整：

- 初始化、销毁及控制命令返回 Promise，允许报告跨 Go 桥操作失败；完成语义需逐项定义。seek 命令被接受不代表已经跳到目标位置，输出设备属性设置成功也不代表已经实际发声。
- 高频状态 getter 同步返回前端快照或时钟推算值，不每帧调用 Go。
- 保留 `clearSource`，纳入切歌取消、本地授权撤销和标签写回时的音频句柄释放流程。
- 内部状态使用引擎无关的 `PlaybackState`。兼容层将其映射到现有 `playing`、`waiting` 等事件，逐步移除业务对 `HTMLMediaElement.readyState` 等浏览器细节的依赖。
- 错误保留来源，不将网络、设备和库初始化错误一律伪装为浏览器“不支持格式”。现有 `getErrorCode()` 如需过渡，只在兼容层映射。
- 订阅返回专属取消函数，不能通过清空某类事件的全部监听器来替代自身清理。
- 浏览器 EQ／频谱能力会随音源和图谱状态变化；监听能力变化，不能只在构造时复制一次能力对象。
- 不搬入 SPlayer 与当前需求无关的自动混音、音高、滤镜时间调度等扩展接口。

音源描述需要沿用并扩展现有 `AudioSourceInfo`，将平台、格式和本地文件信息传到适配层。上面的 `play(url, options)` 展示的是方法骨架，实施时不能丢失现有音源描述、取消信号和播放意图校验。`src` 的跨引擎含义应统一为当前资源标识，业务不能继续通过比较浏览器网关 URL 判断本地资源是否仍可播放。

## 引擎、输出设备与设置

```text
音频输出
  播放引擎    [ Web Audio / mpv ▾ ]
  输出设备    [ 系统默认         ▾ ]
```

建议持久化 `playbackEngine` 和按引擎分组的 `outputDevices`，分别保存设备 ID 和用于设备失效时展示的名称。以内部统一的默认值表达“系统默认”，在适配层映射到浏览器的 `default` 和 mpv 的 `auto`。

- 从原有 `playDevice` 迁移时只填入浏览器引擎的设备设置，不能将其复制给 mpv。
- mpv 从 `audio-device-list` 读取结构化列表，设置 `audio-device`，不请求麦克风权限。浏览器沿用现有枚举及权限流程。
- 设备枚举失败需要反馈错误，不能伪装成只有系统默认设备的成功结果。
- 刷新列表后保留失效的已选设备和名称，标记不可用，避免静默覆盖保存值。
- 指定设备失效时暂停，不接受原生输出后端悄悄回退继续发声。需验证设备列表、当前输出状态与平台行为，必要时停用原生输出并要求用户重新选择。
- “系统默认”允许跟随操作系统的默认设备；对明确指定的设备执行失效暂停策略。
- UI 只展示设置、所选值、必要的不可用状态和操作反馈，不展示 purego、库搜索路径等实现说明。

## 切换流程与并发

1. 保存用户新选的引擎或设备，建立新的切换请求代次，记录当前歌曲、进度、音量、倍速和播放意图。
2. 停止旧引擎发声并撤销旧会话的事件和待完成加载；确认释放后再让新引擎输出。
3. 初始化目标引擎，刷新并校验其已保存设备；失效则暂停并等待用户选择。
4. 重新解析当前歌曲在目标引擎下可用的音源，应用设备、音量和倍速；源地址已过期时走现有解析链路。
5. 先以暂停状态加载，完成后恢复进度，再依据最新播放意图决定是否开始；原状态暂停时不能短暂发声。
6. 任一步失败都保留新设置，清理未完成会话并停止播放，反馈错误。用户可以重试或重新选择引擎／设备。

所有命令和事件带引擎生命周期、播放会话及必要的请求标识；快速切歌、重复切换、暂停或销毁使旧请求失效。取消不是播放错误，不能触发下一首。只有当前会话的自然 EOF 才触发应用自动切歌；stop、replace、切换设备和销毁产生的结束事件不能冒充 EOF。

用户在切换期间主动暂停、切歌或撤销本地资源时，恢复步骤必须读取最新意图，不能无条件恢复进入流程时的播放状态。

## 音源与本地资源

- 本地扫描补充 `.dsf`／`.dff`，沿用大小写、文件名和元数据解析失败时的现有收录规则。
- 在线链接筛选根据当前引擎能力处理 DSD、APE 等格式，替换 `src/utils/song.ts` 中无条件过滤的逻辑；不修改下载能力来冒充播放能力。
- 扩展名只用于候选筛选，实际支持由打包 libmpv 的 demuxer／decoder 和真实文件决定。DSF／DFF、压缩变种及其他容器逐项验证，不承诺 SACD ISO 等未经验证的格式。
- 网络播放复用现有网关和音源解密；验证重定向、Range、鉴权、代理、取消、过期 URL 和 seek。任何子资源也必须遵循同一网络策略，不能由 mpv 绕过应用代理或鉴权链路直接访问上游。
- 本地 mpv 可读取已选择资源的绝对路径，但仍须遵守已有授权、撤销和文件操作边界。不能接受任意路径而绕过应用的资源检查。
- 保存当前本地歌曲标签前，停止并释放 libmpv 文件句柄，确认完成后才允许替换原文件；特别验证 Windows 文件占用。原生读者需要纳入现有写入协调，不能只清空浏览器音源。
- 封面、歌词和标签仍由应用读取和展示，不依赖 mpv 内部元数据替代现有业务模型。

## 歌词时钟与响应式边界

Go 提供包含会话、位置、时长、播放状态和速率的快照。前端以 `performance.now()` 为本地单调时钟锚点，仅在实际播放且未缓冲时推算位置，并定期接受原生进度校正。

- seek、暂停、恢复、缓冲、速率变化、切歌和引擎切换重建时钟锚点；有界时长时限制推算范围。
- 延迟到达或旧会话的快照不允许覆盖新位置；Go 与 JS 的时钟原点不能直接相减。
- 主窗口歌词保持 RAF 同步读取，桌面歌词复用现有时钟发布通道，避免建立相互竞争的两套播放时钟。
- 进度快照及 RAF 限制在实际消费进度的模块，不把高频状态传播到设置页、引擎选择器或无关页面。
- 页面隐藏不等于停止后台播放；会话终止、应用退出和引擎销毁时取消订阅、定时器及原生事件循环。

## 原生绑定与分发

`go-mpv` 支持通过 `nocgo` 或 `CGO_ENABLED=0` 使用 purego，但其当前无 cgo 实现在包 `init()` 中加载 libmpv，找不到库会 panic。直接导入后，库缺失可能在应用选择引擎前阻断启动，不能靠业务方法内部捕获来解决。

当前采用项目内的最小 purego C API 绑定，依据 mpv 0.42.0 / client API 2.6 核对 ABI，从应用资源目录显式延迟加载并返回分类错误。没有直接导入 go-mpv 的主动初始化实现；命令、设备 node 和事件数据仅覆盖播放器实际使用的接口。

- 从 mygo 资源目录的明确路径加载应用随包库及依赖，不依赖系统 PATH 或 Homebrew 等用户环境。
- 只在选择 mpv 或枚举其设备时初始化原生能力；库缺失和 ABI 不兼容要可报告，浏览器引擎仍可启动。已保存 mpv 而加载失败时保留设置并停止，允许手动改选浏览器引擎。
- 固定平台／架构产物、SHA256、libmpv API 版本、FFmpeg 编解码配置和来源，沿用现有资源打包机制。
- 为项目实际发布的目标准备库；不能从 purego 支持某架构推导出该架构的 libmpv 包已经可用。
- macOS 处理 dylib 依赖路径并纳入现有 ad hoc 签名流程；本方案不新增开发者签名或公证要求。Windows 验证 DLL 依赖；Linux 验证 ABI 基线和运行时依赖。
- 随包整理绑定及实际 libmpv／FFmpeg 构建对应的许可证、来源和必要材料。包体增量以实际产物测量，不提前给出估算结论。
- 进程内 libmpv 失去外部进程的故障隔离；原生崩溃不能作为普通可恢复命令错误处理。固定版本和真实平台验证是交付的一部分。

参考：[go-mpv](https://github.com/gen2brain/go-mpv)、[mpv 手册](https://mpv.io/manual/stable/)。

## 实施顺序与验收

| 阶段 | 工作                                           | 验收重点                                                                  |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | 落地精简 `IPlaybackEngine`，包装现有浏览器实现 | 原有播放、取消、EQ、频谱、输出设备、歌词及标签保存流程不回归              |
| 2    | 确定绑定和随包库，建立 Go 服务及平台 provider  | 库缺失不阻断浏览器启动；本地 DSF／DFF 实际发声、暂停和 seek；正确释放句柄 |
| 3    | 接入网络音源、进度事件和歌词时钟               | 网关／解密／代理链路、Range、seek、缓冲及歌词同步；旧事件不能污染当前歌曲 |
| 4    | 接入设置迁移、设备枚举及立即切换               | 分引擎记忆设备；暂停切换不偷播；失败保留新设置；指定设备失效暂停          |
| 5    | 完成三平台库分发和安装包验证                   | 无预装 mpv 的环境启动与播放；动态库依赖完整；各目标分别记录实测证据       |

逻辑验证覆盖取消和竞态、错误分类、设置迁移、时钟推算以及文件读者释放。接口包装本身不要求为每个转发方法编写镜像测试，应针对真实行为风险验证。前端业务变更运行相关测试、类型检查、指定文件 ESLint 和格式检查；Go 变更按仓库要求验证；构建与资源变更验证对应打包产物。

实机分别验证本地与网络 DSF／DFF、常见 MP3／FLAC、播放和暂停中切换引擎、连续 seek、快速切歌、倍速、设备拔插及重连、标签保存、系统媒体控制，以及普通／AMLL／Monet 歌词效果。组件更新验证分别触发无关高频进度和必要业务状态，确认设置页不随进度更新，设备和引擎变化仍正常反映。

静态编译、测试和设备属性读取不能替代可闻声音、实际输出设备及歌词同步验收；未测试的平台和音频变种明确保留为未验证。

## 当前实现与剩余验收

- 原生实现采用最小 purego 绑定，延迟从应用资源目录加载；合同与已验证边界见 [原生检查点](mygo-mpv-runtime-checkpoint.md)。
- 主播放器已接入 `MpvPlaybackEngine`、原生快照前端时钟、设备迁移和立即切换；本轮检查与未覆盖场景见 [UI/播放器检查点](mygo-mpv-ui-checkpoint.md)。
- mpv 首期通过能力声明关闭 EQ、频谱和渐入渐出，保留浏览器设置；切回浏览器后恢复。
- 正式分发、各目标原生库实跑、对应源码材料与应用验收范围以 [资源检查点](../../scripts/mpv/CHECKPOINT.md) 为准。
- 独立审查的四项 P1 已修复：mpv 命令/音源错误统一停止且保留当前歌曲；快照校正不吞同会话的 ended/error 通知；DFF 使用 `iff`，WebM 使用 `matroska`。真实 Player+mpv 回归和生产初始化/Load/受控网关的合成 WAV/DSF/DFF/WebM 真库 `ao=null` 回归已通过；最终复核中 `go vet ./...`、`pnpm lint:go`、`go test ./...`、`go test -race ./...`、Node 24.12.0 下的默认测试与类型检查均通过。
- 独立产物仓库 [he-music/mpv-bundles](https://github.com/he-music/mpv-bundles) 已在 [CI 42180144126](https://github.com/he-music/mpv-bundles/actions/runs/42180144126) 完成五目标原生构建、`ao=null` 控制、Windows 最终链接输入/对应源码材料及统一索引检查，正式发布 [v0.42.0-1](https://github.com/he-music/mpv-bundles/releases/tag/v0.42.0-1)。HE-Music 通过真实 `bundles.lock.json` 固定下载并校验，常规构建不再编译 libmpv 源码。
- 仍须在隔离 App 与真实输出设备中验证可闻声音、设备拔插、歌词同步、系统媒体和 Windows 文件占用。普通／AMLL／Monet 歌词效果与设置页组件更新计数尚无实机通过声明。

## 上一阶段父会话核对（历史）

- 已复跑默认 `pnpm test`：188 个文件、1649 项通过；`pnpm typecheck`、`go vet ./...`、`go test ./...`、`pnpm lint:go` 通过，Go lint 为 0 issues。
- 在最终 Go 修复后重新构建 `build/mygo/mpv-final/darwin-universal/HE-Music.app`，包含最新桌面前端和宿主，构建报告 111.3 MB；`codesign --verify --deep --strict` 通过。构建保留 Vite 的混合静态/动态导入提示，未配置更新签名密钥，未生成签名更新包。
- staging 与包内 `libmpv.2.dylib` 的 SHA256 一致：`795344bb19a0cbde167f556d6d7e624070181ae45084a4551ed7d958ae9a10d1`。使用包内库再次运行生产受控网关的 WAV/DSF/DFF/WebM `go test -race` 回归，通过；`ao=null` 不代表可闻声音。
- 临时 `.pi/settings.json` 已清理；未提交 Git，保留任务期间的外部改动。Windows/Linux libmpv 原生构建已在独立仓库 CI 通过；实际输出设备、HE-Music 安装包和歌词界面仍按上文记录验收边界。

上述源码和自动化验证不替代真实平台验收。

## 固定产物交付核对（修订 1 历史）

- 2026-11-06：五份正式归档及清单已从公开 Release 重新下载，归档、内部文件、原生架构、Windows 材料和所有 API 摘要均核对。消费端已验证无缓存离线 check 和 staging 无副作用复用。
- 新建 `build/mygo/mpv-bundle-v1/darwin-universal/HE-Music.app`，111.2 MB，前端类型/构建与双架构宿主打包通过，ad hoc 签名严格检查通过。包内库 SHA256 为 `9784f8ed8b2cca91f5c3d1ff05ff767ac301db4df9cbeba2a24d67c4e78c7855`，完整资源清单匹配固定锁。
- 正式包内库的生产受控网关 WAV/DSF/DFF/WebM Go race 回归及本机 DST 压缩 DFF 进度/暂停/seek/继续通过，全部 `ao=null`。未启动用户 App 或上传私有样本。
- Node 24.22.1 下资源 51 Python + 3 Node、Release 24、vendor 8 项测试通过，指定 ESLint/Prettier、workflow actionlint 通过；最终消费接线独立审查无问题。范围和历史记录见 [资源交付检查点](../../scripts/mpv/CHECKPOINT.md)。

## 精简运行资源（当前修订 2）

- [v0.42.0-2](https://github.com/he-music/mpv-bundles/releases/tag/v0.42.0-2) 将五份运行包与单一共享材料包分开；原生库字节与已验证 v1 相同。HE 默认只下载运行包，`mpv` 目录只安装二进制，许可证归统一目录，完整源码和构建/重建材料不进入应用。
- 新 `build/mygo/mpv-slim-v2/darwin-universal/HE-Music.app` 为 65.58 MiB（68,764,934 字节），对比 v1 减少约 41%。未采用 UPX，保留 mygo 已有 `-s -w`、`-trimpath`。
- 签名严格检查、包内库/许可清单、生产网关 WAV/DSF/DFF/WebM Go race 和私有 DST 压缩 DFF 的 `ao=null` 控制回归通过。公开五目标下载、无缓存离线校验及无副作用复用通过，资源测试为 62 Python + 3 Node。完整证据见 [交付检查点](../../scripts/mpv/CHECKPOINT.md)。
