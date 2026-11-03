# mygo 桌面入口与原生探针

正常入口为 `main.go`，平台服务位于 `platform.go`。Web、Electron 与 mygo 共用
`src/platform` 的 `PlatformAdapter`：系统平台、能力声明、窗口控制、可退订的最大化事件和
HTTP(S) 外链。`mygo.bindings.ts` 由固定版本 CLI 生成并纳入源码；`mygo.json` 的 bindings
路径保持一致。修改服务后执行 `go tool mygo generate`，不要手改生成客户端。

mygo 采用系统原生标题栏，托盘初始化成功且应用壳就绪后沿用关闭提示及隐藏/退出偏好；
托盘不可用或壳卸载后原生关闭放行，显式退出绕过提示。
Electron 原有 IPC、认证身份及协议兼容分支暂留。mygo 不会设置 `isElectron`，未实现的桌面
歌词、本地音乐、更新和协议注册不会因此启用。全局快捷键仅注册播放/暂停、前后切歌与音量
五项。认证服务使用独立 Go 服务与生成客户端，不伪造 Electron 的 app_type/client_type。

## Linux 正常启动与图形兼容模式

首次启动默认使用正常模式。Linux mygo 应用提供 **设置 → 外观 → 图形兼容模式**：启用后保存到本机用户数据目录，彻底退出应用再启动即可生效；之后直接双击程序或从应用菜单启动会继续沿用。关闭开关并重启可恢复正常模式。页面会显示本次进程正在使用的模式，保存失败时保留原选择。

图形偏好由原生启动流程在加载 GTK／WebKit 之前读取，独立存放在 `PathUserData/linux-graphics.json`，不随可移植业务备份导入其他机器；恢复设置／清除全部数据时会重置。这里只提供手动选择，不自动检测或回退。显示正常时保持关闭，保留通常更低的 CPU 开销。

受影响机器如果在正常模式下出现歌词拖影、黑屏或 EGL／驱动相关显示问题，而软件 GL 模式显示正常，则使用兼容模式。诊断便携包中先从托盘完全退出旧进程，再运行：

```sh
./Start-Diagnostic.sh software-gl
```

从仓库运行诊断脚本时，需要明确提供程序路径，例如已安装的 DEB：

```sh
sh scripts/diagnostics/mygo-linux.sh software-gl /opt/he-music/he-music
```

兼容模式在启动前请求 Mesa 软件 GL 和 Skia CPU 绘制，同时保留合成；不能使用旧版通过关闭合成实现的 `cpu` 模式。兼容模式可能增加 CPU 占用，影响续航或动画帧率，其效果取决于系统图形栈。

诊断脚本的 `normal`／`software-gl` 会显式覆盖本次启动，并清除或设置对应图形开关；不会更改设置页保存的选择。环境开关仅影响本次程序及其子进程，不改变终端父进程或系统配置。模式之间切换需要从托盘彻底退出已有实例；关闭后从普通应用菜单启动会恢复已保存的选择。

用户的 Ubuntu 22 X11 x86-64 机器已确认 `software-gl` 无拖影，正常模式仍有拖影；不能将兼容模式通过记录为正常模式通过。Go 层显式启用歌词合成，两种启动模式都保留这项要求。图形兼容模式不代替 GStreamer 运行依赖，播放卡顿应独立检查。

## macOS WKWebView 集成探针

`nativeprobe.go` 只有显式 `-tags=nativeprobe` 构建才替代生产入口，且运行必须设置
`HE_MUSIC_NATIVE_PROBE=1` 和绝对输出目录 `HE_MUSIC_NATIVE_PROBE_OUTPUT`。普通构建完全
排除此文件，没有运行时探针开关或任意 JS 注入接口。

隔离边界修正：固定 SDK 的 `App.SetPath(PathUserData, ...)` 只覆盖 Go 应用路径；Darwin 建窗未配置独立 `WKWebsiteDataStore`。历史记录中的“临时 profile”仅能证明该应用目录及新页面 origin，删除它不能证明清理了 WK 默认数据存储。未检查真实 Storage，也没有证据证明用户数据被读取或泄漏；不得为核对而读取或清空默认存储。

设置文件三轮业务前探针均失败，picker 0/0，文件功能仍未验收。后续一轮 startup-only 私有 WK 诊断完成了配置标记核验，但准备门控和最终 surface 仍失败。document 报告 hidden，自有 RAF 为 0，而 timer、Vue 和 DOM 有推进；准备失败已清理观察器，尚不能确认因果根因。

文件身份策略、新控制器和有限阶段记录已通过静态审查。当前诊断产物的一次新静态 A1 已完成构建、签名及完整输入冻结，并获独立复核通过：前后 1845 项输入范围、2177 个节点无新增、删除或变化，签名前后的程序载荷绑定比较通过。该产物尚未运行，早先输入冻结缺失及两轮 include 校验阻断的失败记录仍保留。

此前一次获批 fresh 实跑确认了应用回调和终止，但 Go 诊断因 deadline 超时，未封存联合 Ready 成功记录或返回诊断 DTO；三个 false 是默认未完成值，不能当作已执行的 surface 检查失败。外层另有 Vite 清理未确认故障，父后置观察到原进程和组已消失，未补发信号或覆盖原失败。新版句柄和诊断解析候选的 38 项纯测试及 A0 复核通过，Swift 身份候选又完成两次静态编译与 30 项纯 fixture 执行并获独立复核；尚未接入实际运行。这两项运行时 P1、WK 根因及设置文件业务验收仍未解决，下一步先准备新的运行方案。详细身份、边界和历史失败见迁移日志。

工具链应使用 Go 1.27.3、Node 24 LTS、pnpm 10.28.1，并确保 Go 的 bin 在子进程 PATH 首位。
本机已验证的命令示例：

```sh
PATH=/Users/wangjian/.govm/go/bin:$PATH GOFLAGS=-tags=nativeprobe \
  HE_MUSIC_NATIVE_PROBE=1 HE_MUSIC_NATIVE_PROBE_OUTPUT=/tmp/hemusic-nativeprobe-packaged \
  mise exec node@24.22.1 -- pnpm run build:desktop:mac

HE_MUSIC_NATIVE_PROBE=1 HE_MUSIC_NATIVE_PROBE_OUTPUT=/tmp/hemusic-nativeprobe-packaged \
  build/mygo/darwin-arm64/HE-Music.app/Contents/MacOS/HE-Music

PATH=/Users/wangjian/.govm/go/bin:$PATH GOFLAGS=-tags=nativeprobe \
  HE_MUSIC_NATIVE_PROBE=1 HE_MUSIC_NATIVE_PROBE_OUTPUT=/tmp/hemusic-nativeprobe-dev \
  mise exec node@24.22.1 -- pnpm run dev:desktop
```

探针在独立 origin 加载共享页面；打包时使用唯一的 mygo host，开发时用临时 loopback
端口反代实际 Vite 开发入口。Go 用户数据目录也是临时目录。基础页面检查返回 Vue 根、布局、字体
和图标资源、设置页路由、错误计数、窗口状态和事件接收/退订布尔值；只截取自己的窗口，
不提取存储、账号或令牌，不填写或提交登录。应用自己打开的登录或用户协议弹窗可能出现在
截图中，这不代表登录通过。
开发模式另执行下述 M4 合成媒体与歌词矩阵，打包模式明确跳过该媒体入口。

总超时 45 秒，页面条件轮询上限 20 秒；结束时关闭自己的窗口、loopback 代理并删除临时
Go 数据目录，开发 CLI 随应用退出清理 Vite。输出为 `result.json` 和成功捕获的
`wkwebview.png`。必须检查本次 JSON 的 `passed: true`，并确认没有 `timedOut` 或
`runFailed`；进程退出码和之前遗留的 PNG 不能单独作为通过证据。Vite 首次依赖预构建可能
触发整页刷新，使正在执行的 Eval 中断；保留失败记录，服务器缓存就绪后再独立运行。

探针会覆盖标准路径的本地构建产物。验收结束后不带 `GOFLAGS` 运行正常
`pnpm run build:desktop:mac` 恢复生产产物，并检查二进制构建参数没有 nativeprobe 标签。
Windows 需要按迁移清单单独实测；macOS 的合成检查不代替 WebView2、真实认证或媒体播放验收。

## M3 原生认证串接检查

同属 `nativeprobe` 构建标签的 `nativeprobe_auth.go` 复用上述隔离、总超时和清理。
页面通过实际 `window.mygo.call` 调用 `AuthCallback.Prepare/Arm/Cancel`，由 Go HTTP
客户端发送合成回调，再验证 `desktop:auth-callback` 事件中的 sessionId/state，以及错误
state、取消后的迟到回调、重复回调、退订和端口释放。检查不创建真实授权会话、不兑换令牌，
因此仅证明原生回调与页面事件串接，不能代表真实第三方登录或扫码确认通过。

公开请求通过 XHR 被动观察应用原有的 providers/platforms 请求，仅保留类别、HTTP 状态、
CORS 是否可读和 provider 数量，不记录请求头、令牌、完整 URL 或响应正文。公开请求的结果
独立记录，不影响合成回调的 passed 判定，不能由其推断全部后端或所有 origin 已兼容。

普通生产构建排除所有 nativeprobe 探针文件；官方生成客户端所需的 `MYGO_GENERATE` 优先分支保留。
探针完成后仍需恢复普通生产包，并分别记录未验证的真实账号授权、Windows 与媒体场景。

## M4 合成媒体与播放器内歌词

`nativeprobe_media.go` 同属 `nativeprobe` 标签，仅开发模式通过 Vite 导入
`src/nativeprobe/media.ts`，复用已挂载的 FullPlayer 和实际 Player/AudioManager 单例。
该 TS 没有生产入口 import，普通 bundle 不包含测试入口。临时 loopback 服务提供 16 秒、
8 kHz 单声道 PCM 静音 WAV 并支持 Range；仅替换合成歌曲地址和歌词输入、封面取色与历史
副作用，finally 还原方法、设置和 store，结束时关闭临时服务。

检查加载、程序调用 play、暂停、seek 和迟到取源后的切歌；普通、AMLL、Monet 的实际文本与
DOM 随时钟、偏移、暂停 seek 和歌词更新，以及半屏歌词布局、纯歌词模式、原生隐藏后的
RAF 和卸载清理。输出 `media-<effect>.png`（纯歌词）、`media-<effect>-half.png` 和 JSON；
必须逐项检查媒体 `passed`、`runtime`/`postCleanupRuntime` 和 `cleanup`，不能凭进程退出或
截图存在判定通过。

这不是用户手势、可闻输出、真实后端歌曲 URL/歌词接口或真实账号验收；歌词输入为合成
普通 LRC，逐字歌词和真实编码格式仍需用户播放。打包 JSON 的 `mediaIntegration.passed=false`
及 `developmentOnlySkipped=true` 表示未测媒体，总 `passed` 仅覆盖该模式实际执行的页面和
回调检查，不能代表打包播放器通过。

AMLL 暂停时保留 core 原有动画循环，弹簧及暂停节流改进按用户安排留待其后续升级。
探针对该效果的暂停零 RAF 检查显式记录 `pausedEffectCleanupSkipped=true` 与
`pausedEffectPolicy=existing-core-animation`；这不等于暂停空转已优化。隐藏与卸载的 RAF
清理，以及页面错误计数仍须通过原有检查。

开发合成探针可在临时窗口安装可清理的输入隔离，只计受信事件类型、固定阶段和数量，
不记录按键、输入值或任意文本，也不代表用户手势验收。截图前仅处理已识别的初始登录/协议
提示，关闭协议提示不表示同意、不写同意记录；晚到的登录提示仅在观察到匿名 401 后，通过
已知取消控件关闭，并记录前后状态。未知弹窗仍使探针失败，modal 与 drawer 遮挡门控保留。
播放队列状态单独保存、归零并还原，隔离监听和被动请求观察均须清理。所有原生运行与构建、
绑定生成和源码写入严格串行；本轮隔离修正仅执行一次原生运行并保留原失败证据。

## 托盘与关闭生命周期

`DesktopLifecycle` 只管理显式绑定的主窗口和所属页面。前端先订阅定向关闭请求、托盘动作，
再调用 `ready`；关闭提示显示并完成 `nextTick` 后立即 `acknowledgeClose`，确认后才
`resolveClose`，不得等待用户选择才 ack。5 秒超时仅针对未确认接收，已显示提示可一直等待。
卸载时先 `teardown` 再退订。`syncConfig` 仅同步关闭偏好和语言，`syncPlayback` 仅同步播放
状态及当前曲目可播放性，不传播放进度或歌词时钟。

独立生命周期探针使用以下命令，不运行原来的媒体矩阵：

```sh
GOFLAGS='-tags=nativeprobe,lifecycleprobe' HE_MUSIC_NATIVE_PROBE=1 \
  HE_MUSIC_NATIVE_PROBE_OUTPUT=<绝对新目录> pnpm run dev:desktop
```

该探针有 45 秒总超时、独立 origin 和临时 Go 数据目录。必须核对本轮 `result.json` 的
`passed`、失败阶段、诊断和要求的文件；不能由退出码推断成功。托盘安装通过实际 Bounds
检查，菜单对象回调由程序调用，不能写成已验证系统托盘鼠标点击或 Dock 鼠标点击。普通包
排除所有探针。本轮不进行 Windows 运行测试，功能迁移完成后统一依清单验证。

## 全局快捷键独立探针

```sh
GOFLAGS='-tags=nativeprobe,shortcutprobe' HE_MUSIC_NATIVE_PROBE=1 \
  HE_MUSIC_NATIVE_PROBE_OUTPUT=<绝对新目录> pnpm run dev:desktop
```

仅在隔离 origin 的临时配置中注册 `Ctrl+Alt+Shift+F19`，验证真实 provider 的注册、本服务
查询、录制暂停/恢复、禁用和退出注销；不读取正常应用的快捷键配置，不注销其他服务的组合。
回调链使用程序发送的定向事件，`nativeKeyPressTested=false`，不得宣称已验证操作系统按键
触发。普通构建排除 probe；运行与构建、绑定生成、源码写入严格串行。Windows 当前完全不测。
