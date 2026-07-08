# HE-Music

> 一个简约的音乐播放器，基于 [SPlayer](https://github.com/imsyy/SPlayer) 修改和跟随, SPlayer 是一个非常漂亮的播放器。
>
> 该版本为无后端的纯前端，不能独立运行，和 SPlayer 不兼容，不知道后端服务的用户请使用 SPlayer

基于 Flutter 的由 AI 驱动的安卓版本 [HE-Music-Flutter](https://github.com/he-music/HE-Music-Flutter.git)

## 第三方登录说明

`LinuxDo` level >= 3

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
- 🔄 歌词滚动以及歌词翻译
- 📹 MV 与视频播放
- 🎶 音乐频谱显示
- ⏭️ 音乐渐入渐出
- 🔄 支持 PWA
- 💬 支持查看评论
- 📱 移动端简单适配
- 🌐 `i18n` 支持

## ⚙️ 本地部署

1. 本地部署需要用到 `Node.js`。可前往 [Node.js 官网](https://nodejs.org/zh-cn/) 下载安装包，请下载最新稳定版
2. 安装 pnpm

   ```bash
   npm install pnpm -g
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

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=he-music/HE-Music&type=Date)](https://api.star-history.com/svg?repos=he-music/HE-Music&type=Date)
