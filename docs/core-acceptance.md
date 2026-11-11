# 核心链路验收

本清单用于版本回归及播放器相关改动验收。使用 `CONTEXT.md` 中的产品术语。

## 自动检查

使用 Node 24 LTS、pnpm 10.28.1 和 `go.mod` 指定的 Go 版本：

```sh
pnpm test:core
pnpm typecheck
pnpm check:runtime
pnpm vendor:check
pnpm test:desktop:vendor
pnpm test:desktop:release
pnpm test:desktop:mpv
go test ./...
pnpm build:web
```

`test:core` 选择启动、播放引擎、播放器、元数据匹配、本地歌单、曲库同步、已下载取源、下载会话、更新会话和虚拟列表的现有测试。提交前运行 `pnpm test` 覆盖完整前端测试；PR 和发布流程自动运行全量检查。

Vitest 使用 Node 环境。测试通过证明所覆盖的逻辑与模拟交互成立，不代表实际声音、原生窗口、系统控件或安装升级已经验收。

## 场景矩阵

| 场景               | 操作及通过条件                                                                            | 主要自动覆盖                                                                                                                           | 必须补充的实际交互                                                         |
| ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 启动与恢复         | 成功进入主界面；平台、网关、窗口加载失败可重试；数据／设置恢复失败不挂载旧状态            | `src/bootstrap/`、`src/platform/preferencesResetStartup.test.ts`                                                                       | 正常安装包首次启动、异常后重开；Web 中阻断窗口模块后解除阻断并重试         |
| 登录生命周期       | 成功只领取一次结果；取消、超时、重试和迟到响应不误登录                                    | `src/platform/oauthFlow.test.ts`、`src/components/Modal/Login/Login.lifecycle.test.ts`                                                 | 每个真实授权平台、密码／扫码、刷新令牌、登出及生产 origin                  |
| 播放、暂停与跳转   | 播放和暂停状态正确；可跳转到 0；策略拒绝保留曲目、歌词和进度，下一次点击可恢复            | `src/utils/player.compatibility.test.ts`、`src/utils/player.audioPause.test.ts`                                                        | 实际可闻 MP3／FLAC、用户点击、HTTP／HTTPS、重定向、Range                   |
| 快速操作与播放意图 | A／B／A 只提交最终歌曲；取源或设备准备期间暂停不自动出声；旧壳不撤销新壳意图              | `src/utils/player.controlIntent.test.ts`、`src/utils/audioManager.processing.test.ts`                                                  | 快速切歌及前后台操作，核对声音、标题和歌词一致                             |
| 引擎切换与失败恢复 | 切换保留当前音质及进度；用户确认后才切 mpv；旧提示失效；重试达到预算后停止                | `src/utils/audioManager.switch.test.ts`、`src/utils/player.test.ts`、`src/utils/player.controlIntent.test.ts`                          | 实际不兼容格式、输出设备、网络中断与 mpv 可用性                            |
| 歌词与组件更新     | 暂停跳转、偏移、换歌词和设置仍更新；半屏歌词布局保留封面；无关进度变化不更新导航／页面壳  | `src/components/LyricStage/`、`src/components/AMLL/LyricPlayer.lifecycle.test.ts`                                                      | 普通／逐字歌词、各歌词效果、纯歌词模式、缩放、隐藏后恢复；记录组件更新计数 |
| 列表与本地播放     | 搜索追加不跳动；筛选后前后切歌索引正确；只使用仍有效的本地授权                            | `src/components/UI/VirtualScroll.test.ts`、`src/utils/player.mode.test.ts`、`src/utils/player.local.test.ts`                           | 大曲库、中文路径、重新授权、目录撤销与文件移动                             |
| 元数据编辑         | 候选需用户确认；失败或过期响应不改表单；仅显式保存落盘；保存 A 不干扰正在播放的 B         | `src/platform/localMetadataMatch*.test.ts`、`src/components/Modal/MygoSongInfoEditor.test.ts`、`desktop/files_metadata_commit_test.go` | 实际标签／封面／歌词保存、外部修改冲突、其他歌曲持续播放                   |
| 下载任务           | 取消、重试和清理记录有正确反馈；撤销目录后不接收旧结果；清理任务不删除已下载文件          | `src/platform/localDownloadSession*.test.ts`、`desktop/download_durability_test.go`                                                    | 各文件格式、磁盘写入失败、不覆盖原件、取消后清理与重启恢复                 |
| 桌面控制           | 托盘、快捷键、系统媒体、任务栏命令各执行一次；旧代际和失效授权不误控                      | `src/composables/shell*.test.ts`、`src/platform/systemMedia*.test.ts`、`desktop/lifecycle_test.go`                                     | 真实 OS 按键、托盘左键恢复、Explorer 重启、系统封面及显示器防休眠          |
| 设置与数据         | 导入整体校验，写入失败回滚；取消不改数据；关闭页面后旧结果和重载计时器失效                | `src/platform/rendererSettings.test.ts`、`src/platform/settingsFilesIntegration.test.ts`                                               | 原生 Open／Save、文件占用、ACL、重命名失败、备份恢复及退出重开             |
| 安装与更新         | vendor 一致，普通包不含探针和 Electron 运行依赖；更新验签；失败保留旧安装；安装后提示重启 | `scripts/vendor/*.test.mjs`、`scripts/package/mygo-release*.test.mjs`、`src/platform/updatesSession.test.ts`                           | 独立测试安装、真实 feed、升级失败及重启；Windows WebView2、Linux 运行依赖  |

## 平台边界

- Windows 透明窗口、边框和下载已有历史实机确认；托盘左键恢复等新交互仍应按当前包复测。详细项目见 [Windows 清单](plans/mygo-windows-checklist.md)。
- mygo 第三方授权使用后端 session／status／result 轮询，不再监听本机 OAuth 回调端口；Web 的回跳流程单独验收。
- Linux X11 兼容模式及歌词穿透已有历史确认；正常图形模式拖影和 Wayland 交互分别记录，不把兼容模式结果用于证明正常模式通过。
- macOS 历史 WK 探针、设置文件交互中的未完成项仍见 [桌面指南](../desktop/README.md)。本清单不覆盖或抹去历史失败证据。
- AMLL 暂停时保留 core 的原有动画语义，不以“暂停零 RAF”作为当前通过条件；隐藏和卸载仍需正确清理。

## 结果记录

每次记录提交或工作区版本、系统／CPU、WebView 版本、安装方式、场景、结果和证据。状态使用“通过／失败／未执行”，模拟输入、构建成功和实际系统交互分别记录；截图和日志不包含账号、令牌或授权参数。

| 版本／环境                                                             | 场景                                       | 结果及证据                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本轮最终工作区；Node 24.22.1／Go 1.27.3                                | 自动回归与构建                             | 通过：196 个 Vitest 文件、1778 条测试，Node／Web 类型检查，Go 测试、vendor／runtime 校验、桌面脚本测试、工作流静态检查及 Web／桌面前端构建。GitHub Actions 尚未远程触发                     |
| `61680b3` 上的启动兜底工作区；隔离 Chromium                            | 阻断 `mainWindow.ts`，解除阻断并点击重试   | 通过：出现启动提示；重试后 `#app-layout` 挂载。中英文、375px 窄屏、深色背景及键盘焦点已检查                                                                                                 |
| 本轮工作区；隔离 Chromium，合成歌词及临时 render 计数                  | 启动加载与高频更新                         | 通过：[测量记录](frontend-performance.md)包含优化前后脚本正文、延迟加载检查和 60 次进度更新计数；未验证 CPU／续航                                                                           |
| 本轮匹配实现；隔离 Chromium，同源 API mock 与内存 LocalMetadataSession | 手动选候选、回填和显式保存                 | 通过：搜索后 2 个候选、原表单不变、保存计数 0；手动选第 2 项后回填标题／专辑／歌词，保留备注与封面；点击保存后仅 1 次内存保存。375px 下已验证键盘切换平台及长候选换行；未访问真实文件或后端 |
| 本轮工作区；Windows／Linux／macOS 原生应用                             | 真实媒体、原生文件面板、桌面控制及安装升级 | 未执行；不能以 Node 测试或 Web 构建替代                                                                                                                                                     |
