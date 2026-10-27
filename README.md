# HE-Music

> 一个简约的音乐播放器，基于 [SPlayer](https://github.com/imsyy/SPlayer) 修改和跟随, SPlayer 是一个非常漂亮的播放器。
>
> 该版本为无后端的纯前端，不能独立运行，和 SPlayer 不兼容，不知道后端服务的用户请使用 SPlayer

基于 Flutter 的由 AI 驱动的安卓版本 [HE-Music-Flutter](https://github.com/he-music/HE-Music-Flutter.git)

## 第三方登录说明

新用户注册：

- `LinuxDo` level >= 3

## 📜 版权与授权声明

本项目是基于 [SPlayer](https://github.com/imsyy/SPlayer) 的二次开发作品，原始代码版权归属如下：

```copyright
原始项目：SPlayer
版权所有 © 2022-present Imsyy
许可证：AGPL-3.0
源码仓库：https://github.com/imsyy/SPlayer
```

## ⚠️ 注意

- **该项目为纯前端项目，运行时需要搭配对应的后端服务。**
- **不知道后端服务的用户，请使用 SPlayer [https://github.com/imsyy/SPlayer](https://github.com/imsyy/SPlayer)**

## 说明

> [!IMPORTANT]
>
> ### 严肃警告
>
> - 请务必遵守 [GNU Affero General Public License (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html) 许可协议
> - 在您的修改、演绎、分发或派生项目中，必须同样采用 **AGPL-3.0** 许可协议，**并在适当的位置包含本项目的许可和版权信息**
> - **禁止用于售卖或其他盈利用途**，如若发现，作者保留追究法律责任的权利
> - 禁止在二开项目中修改程序原版权信息（ 您可以添加二开作者信息 ）
> - 感谢您的尊重与理解

- 本项目采用 [Vue 3](https://cn.vuejs.org/) + [TypeScript](https://www.typescriptlang.org/) + [Naïve UI](https://www.naiveui.com/) + [Electron](https://www.electronjs.org/zh/docs/latest/) 开发
- 支持网页端与客户端，由于设备有限，目前仅适配 `Win`，其他平台可自行解决兼容性后进行构建
- 仅对移动端做了基础适配，**不保证功能全部可用**
- 该项目为前端项目，运行时需要搭配对应的后端服务。不知道后端服务的用户，请使用SPlayer[https://github.com/imsyy/SPlayer](https://github.com/imsyy/SPlayer)

  > 请注意，移动端只有基础适配

## 🎉 功能

- 💻 支持桌面歌词
- 💻 支持切换为本地播放器，此模式将不会连接网络
- 🎨 封面主题色自适应，支持全站着色
- 🌚 Light / Dark / Auto 模式自动切换
- 📁 本地歌曲管理及分类（建议先使用 [音乐标签](https://www.cnblogs.com/vinlxc/p/11347744.html) 进行匹配后再使用）
- 📁 简易的本地音乐标签编辑及封面修改
- 🎵 **支持播放部分无版权歌曲（可能会与原曲不匹配，客户端独占功能）**
- ⬇️ 下载歌曲
- ➕ 新建歌单及歌单编辑
- ❤️ 收藏 / 取消收藏歌单或歌手
- 📝 支持逐字歌词
- 🔄 歌词滚动以及歌词翻译 [AMLL、folia-莫奈、folia-云阶]
- 📹 MV 与视频播放
- 🎶 音乐频谱显示
- ⏭️ 音乐渐入渐出
- 🔄 支持 PWA
- 💬 支持查看评论
- 📱 移动端简单适配
- 🌐 `i18n` 支持

## 🖥️ 桌面运行环境

- 客户端使用 Electron 44，macOS 最低要求为 macOS 13。
- Linux 默认使用 X11 后端；在 Wayland 会话中需要安装并启用 XWayland，以支持桌面歌词的全局坐标、置顶和非激活显示。
- 启动时显式指定 `--ozone-platform=wayland` 或其他后端会保留该选择；原生 Wayland 下上述桌面歌词能力受 Electron/窗口管理器限制。

## mygo 桌面迁移候选

迁移分支使用固定 mygo / mygo-runtime 和 Go 1.27.3，保留独立 Web 构建。普通 mygo 包不携带 Node/Electron，也不启动旧网易或解灰 Node 服务；Node 24 仅用于前端开发与构建工具。现有 `pnpm dev` 仍是旧 Electron 命令，mygo 使用 `pnpm run dev:desktop`，普通 macOS 候选位于 `build/mygo/darwin-arm64/HE-Music.app`。完整迁移状态见[迁移计划](docs/plans/mygo-migration.md)。

- 系统媒体复用 `smtcOpen`（默认开启），可反复关闭/开启。原生 provider 接管时避免页面 Web MediaSession 重复发布；Web/Electron 保留既有 navigator 能力及兼容保护。
- 在线歌曲支持播放、暂停、上一首、下一首和跳转（包括 0），事件校验当前壳代际、曲目与版本；无歌和本地歌曲不接受原生播放命令。发布实际倍速与必要的播放/暂停、曲目、跳转状态，系统自行推进位置，不按进度/歌词时钟持续 IPC。
- 防休眠复用 `preventSleep`（默认关闭），mygo 仅有实际 provider 时显示开关。用户显式开启且长期壳 Ready 时持有 display lease；关闭、退出或 context 撤销后释放，与播放状态和系统媒体开关独立。
- mygo 原生系统媒体 Artwork 已接入受限 PNG/JPEG 加载，复用当前在线歌曲封面；异步取消和曲目/版本校验避免迟到封面覆盖新歌，缺图或 CORS 失败仅清封面、不阻断播放，Web/Electron 保留原行为。真实跨 origin 图片、普通打包 origin、真实账号/可闻音乐、OS 封面/媒体按键/面板及显示器阻睡眠效果仍需人工验收；Windows 构建和运行全部延后，见[统一实测清单](docs/plans/mygo-windows-checklist.md)。
- mygo 设置 JSON 导入/导出已接入临时文件会话，只处理播放器设置与快捷键，并验证字段、取消、迟到结果及存储失败；页面所有权 P1 已修复并通过真实 SFC 回归。普通 Web/macOS 构建已通过，但三轮 WK 文件探针均停在初始弹层准备，尚无原生导入/导出端到端通过证据。目录授权仅当前会话有效，本地音乐、下载和持久授权未因此开放，详见迁移计划。

以下为历史 macOS 合成探针命令（Node 24.22.1、Go 1.27.3，PATH 按本机安装调整）。`PathUserData` 只隔离 Go 应用目录，不能证明独立 WK 存储；新的 WK 场景应先采用并核对私有数据存储配置，见[原生探针说明](desktop/README.md)。

```sh
task_probe_output="$(mktemp -d /tmp/hemusic-system-media-probe.XXXXXX)"
PATH=/Users/wangjian/.govm/go/bin:$PATH \
  GOFLAGS='-tags=nativeprobe,mediaprobe' \
  HE_MUSIC_NATIVE_PROBE=1 HE_MUSIC_NATIVE_PROBE_OUTPUT="$task_probe_output" \
  mise exec node@24.22.1 -- pnpm run dev:desktop
```

探针使用随机 loopback origin 和临时应用数据目录（不等于独立 WK profile），先禁用媒体、防休眠与全局快捷键，再显式开启合成 fixture；自产 PNG 通过实际 typed session/API 附图，检查 NowPlaying 模块图像字节/hash、Rate 新版本保留和关闭后不再 showing，退出前 Clear/off/release 并清理临时资源。运行期间不要写源码、生成绑定、格式化或构建，防止 Vite reload 污染证据。`result.json` 的模块快照、API 计数、程序定向 callback 和合成 Player 入口仅证明调用/生命周期，不证明 OS 封面显示、真实系统按键或屏幕休眠效果；不得用它控制其他应用。

## ⚙️ 本地部署

1. 本地部署需要用到 `Node.js`。可前往 [Node.js 官网](https://nodejs.org/zh-cn/) 下载安装包，请安装 Node.js 24 LTS，最低为 24.12.0（版本见 `.nvmrc`，使用 nvm 时可执行 `nvm install && nvm use`）
2. 安装 pnpm

   ```bash
   npm install pnpm@10.28.1 -g
   ```

3. 克隆仓库并拉取至本地，此处不再赘述
4. 使用 `pnpm install` 安装项目依赖（若安装过程中遇到网络错误，请使用国内镜像源替代，此处不再赘述）
5. 复制 `/.env.example` 文件并重命名为 `/.env` 并修改配置
6. 打包客户端，请依据你的系统类型来选择，打包成功后，会输出安装包或可执行文件在 `/dist` 目录中，可自行安装

   | 命令               | 系统类型 |
   | ------------------ | -------- |
   | `pnpm build:win`   | Windows  |
   | `pnpm build:linux` | Linux    |
   | `pnpm build:mac`   | MacOS    |

## ⚙️ 发布构建配置

GitHub Actions 发布构建需要在仓库 `Secrets and variables` 中配置 `VITE_API_URL`。该变量会在 CI 构建时通过环境变量注入，优先级高于 `.env` 文件中的同名配置，因此无需把真实 API 地址提交到 `.env.example`。

## 😘 鸣谢

特此感谢为本项目提供支持与灵感的项目

- [SPlayer](https://github.com/imsyy/Splayer)
- [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)
- [YesPlayMusic](https://github.com/qier222/YesPlayMusic)
- [UnblockNeteaseMusic](https://github.com/UnblockNeteaseMusic/server)
- [applemusic-like-lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics)
- [Vue-mmPlayer](https://github.com/maomao1996/Vue-mmPlayer)
- [refined-now-playing-netease](https://github.com/solstice23/refined-now-playing-netease)
- [material-color-utilities](https://github.com/material-foundation/material-color-utilities)
- [folia-major](https://github.com/chthollyphile/folia-major)

## 📢 免责声明

**本项目基于开源项目 SPlayer 进行二次开发，产生的一切责任都与SPlayer以及他的开发者无关！**

**仅供个人学习研究使用，禁止用于商业及非法用途**

**歌曲、图片及歌词来源于网络，仅供学习、交流使用，不具有任何商业用途，如因使用本项目而引起的任何纠纷或责任，均由使用者自行承担。** **本项目开发者不承担任何因使用本项目而导致的任何直接或间接责任，并保留追究使用者违法行为的权利**

请使用者在使用本项目时遵守相关法律法规，**不要将本项目用于任何商业及非法用途。如有违反，一切后果由使用者自负。** 同时，使用者应该自行承担因使用本项目而带来的风险和责任。本项目开发者不对本项目所提供的服务和内容做出任何保证

感谢您的理解

## 📜 开源许可

- **本项目仅供个人学习研究使用，禁止用于商业及非法用途**
- 本项目基于 [GNU Affero General Public License (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html) 许可进行开源
  1. **修改和分发：** 任何对本项目的修改和分发都必须基于 AGPL-3.0 进行，源代码必须一并提供
  2. **派生作品：** 任何派生作品必须同样采用 AGPL-3.0，并在适当的地方注明原始项目的许可证
  3. **注明原作者：** 在任何修改、派生作品或其他分发中，必须在适当的位置明确注明原作者及其贡献
  4. **免责声明：** 根据 AGPL-3.0，本项目不提供任何明示或暗示的担保。请详细阅读 [GNU Affero General Public License (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html) 以了解完整的免责声明内容
  5. **社区参与：** 欢迎社区的参与和贡献，我们鼓励开发者一同改进和维护本项目
  6. **许可证链接：** 请阅读 [GNU Affero General Public License (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html) 了解更多详情

## 友情链接

- [LINUX DO](https://linux.do/) - 真诚、友善、团结、专业，共建你我引以为荣之社区。

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=he-music/HE-Music&type=Date)](https://api.star-history.com/svg?repos=he-music/HE-Music&type=Date)
