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

- 本项目采用 [Vue 3](https://cn.vuejs.org/) + [TypeScript](https://www.typescriptlang.org/) + [Naïve UI](https://www.naiveui.com/) + [Go](https://go.dev/) + [mygo](https://github.com/egoist/mygo) 开发
- 支持独立网页端和 macOS／Windows／Linux 桌面端，平台验收范围见[实测清单](docs/plans/mygo-windows-checklist.md)。
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

- 桌面端使用 mygo 系统 WebView：macOS 使用 WKWebView，Windows 需要已安装 WebView2 Runtime，Linux 使用 GTK3／WebKitGTK。
- Linux 需安装 GStreamer base、good、bad、libav 和 pulseaudio 插件；桌面歌词兼容模式和 X11 穿透说明见[桌面指南](desktop/README.md)。Wayland 歌词交互尚未实机验收。
- 开发使用 Node.js 24 LTS、pnpm 10.28.1 和 Go 1.27.3；mygo 应用运行时不需要 Node.js。

## 桌面与 Web 开发

默认 `pnpm dev` 启动 mygo 桌面开发，网页开发使用 `pnpm dev:web`。Go SDK 及官方 CLI 固定在仓库 vendor 中，构建前运行 `pnpm vendor:check`；不直接覆盖 vendor 或升级 SDK。补丁维护见[固定 SDK 说明](patches/mygo/README.md)。

- 原生能力包括桌面歌词、托盘、快捷键、系统媒体、本地音乐、下载、标签编辑、代理及播放控制；共用原有 Vue 界面和歌词效果。
- Web 使用浏览器存储与下载，桌面端的业务数据由 Go 保存。旧 Electron 数据导出助手和导入兼容仍保留，见[数据迁移说明](docs/mygo-data.md)。
- `pnpm check:runtime` 检查生产源码、类型配置和直接依赖不再引用旧宿主桥接；该检查不替代类型检查、测试和实际界面验收。
- 自动更新尚未配置真实 feed、公钥和 CI 私钥，目前不可用。普通构建与签名更新发布是不同入口，见[更新发布说明](docs/mygo-updates.md)。

## ⚙️ 本地部署

1. 本地部署需要用到 `Node.js`。可前往 [Node.js 官网](https://nodejs.org/zh-cn/) 下载安装包，请安装 Node.js 24 LTS，最低为 24.12.0（版本见 `.nvmrc`，使用 nvm 时可执行 `nvm install && nvm use`）
2. 安装 pnpm

   ```bash
   npm install pnpm@10.28.1 -g
   ```

3. 克隆仓库并拉取至本地，此处不再赘述
4. 使用 `pnpm install` 安装项目依赖（若安装过程中遇到网络错误，请使用国内镜像源替代，此处不再赘述）
5. 复制 `/.env.example` 文件并重命名为 `/.env` 并修改配置
6. 打包客户端，请依据你的系统类型来选择，打包成功后，会输出安装包或可执行文件在 `build/mygo/<平台>-<架构>/` 目录中，可自行安装

   | 命令               | 系统类型 |
   | ------------------ | -------- |
   | `pnpm build:win`   | Windows  |
   | `pnpm build:linux` | Linux    |
   | `pnpm build:mac`   | MacOS    |

## ⚙️ 发布构建配置

GitHub Actions 使用独立 Web 构建与 mygo 平台矩阵，后端地址由 `VITE_API_URL`／`VITE_NETEASE_API_URL` secrets 注入。手动运行生成测试产物；tag 构建必须通过真实更新配置、密钥与产物验签，缺配置时明确失败。验签后的 Release 保持草稿，供安装验收后发布。

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
