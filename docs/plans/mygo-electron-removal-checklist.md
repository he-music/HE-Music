# Electron 移除记录与服务去向

本轮已按用户确认移除 Electron 运行时，桌面端统一使用 mygo，Web 保留独立构建。本变更基于 `27ffc7c`，构建与实机验收范围见下文。源码移除和构建通过不表示所有平台安装、真实业务数据或更新链路已实机验收。

## 已完成的移除

- 删除 `electron/` 主进程、preload、Node 服务及其专用测试；删除旧 builder/Vite 配置、开发脚本、更新配置和 `web/` 加载页。
- 删除 Electron adapter、IPC 初始化、旧更新／标签弹窗、旧下载页和旧本地音乐布局；共享 Vue 界面只保留 Web／mygo 分支。本地歌曲、歌手和专辑子页继续使用 mygo 文件会话。
- 移除 Electron、toolkit、旧 Fastify 服务、Node 标签与字体库等专用依赖，重算 pnpm lockfile。Node 继续作为 pnpm／Vite 开发工具使用。
- 默认 `pnpm dev`／`start` 启动 mygo，`pnpm build` 构建当前桌面平台，`build:mac/win/linux` 转到 mygo。Web 使用 `dev:web`／`build:web`，产物为 `dist/web`。
- Web 类型配置不再继承 Electron toolkit 或引用 preload 声明；Node 类型检查仅负责 Vite／Vitest 配置。
- Docker 构建改用 Node 24、pnpm 和 `dist/web`；GitHub Actions 改为 Web 验证与 mygo 平台构建，测试包归档保留权限。tag 发布必须通过真实更新配置、密钥及产物验签，并保持 Release 草稿。
- 新增 `pnpm check:runtime`，检查直接依赖、生产源码桥接／导入、类型配置和构建命令中的旧宿主引用。

## 继续保留的兼容合同

- `scripts/migration/export-electron-data.js` 用于已发布 Electron 版本的数据导出，继续保留 `electron-migration-1` 导入模型及测试。
- 二维码登录的 `client_type: "electron_vue"`、当前 `app_type` 兼容值与已保存设备 ID 保持原合同；这些协议字段不加载旧宿主。
- `public/icons/tray/`、字体、许可证、版权和致谢继续保留。托盘图标仍由 Go 嵌入并缓存使用。
- 文件 grant/ref/epoch、下载完整性校验、会话所有权、损坏保护、metadata 事务与回滚逻辑继续保留，未因删除旧宿主而放宽。
- mygo SDK 及 vendor 补丁维持固定版本，未升级至 0.7.4，也未改动模块缓存。

## 服务去向

- 旧 Fastify 总服务与静态文件：mygo 使用嵌入前端及 Go 服务；Web 使用独立静态部署，不引入 Node sidecar。
- 网易接口：由 `VITE_NETEASE_API_URL` 配置，或由 HE-Music 后端提供相对 `/api/netease`；mygo gateway 转发固定 API 路由。
- 网易、酷我、波点和歌曲宝解灰：由外部 HE-Music 后端提供 `/api/unblock`，客户端不重新实现第三方服务。
- TTML 歌词：Web／mygo 读取既有数据库资源；mygo 通过资源 gateway 访问，保留歌词效果及布局实现。
- OAuth 回调：`desktop/auth.go` 使用 `prepare(0)` 预留独立 loopback 端口，由后端创建会话及兑换结果；继续校验 owner/session/state、期限和消费状态。
- HTTP 播放控制：保留六条 GET `/api/control/{play,pause,toggle,next,prev,status}`、响应 envelope 和可配置端口；默认 25666，仅 loopback。命令 receipt 不证明扬声器已发声。
- 文件、标签、扫描与下载：由 `NativeFiles` 和对应的授权、持久任务及事务实现负责。
- 更新与安装：使用 mygo updater provider、签名清单与发布检查脚本。真实 feed、公钥和 CI 私钥缺失时明确拒绝发布。

## 本轮验证结果

在仓库忽略的独立目录中复制当前源码和锁文件，未复制 `node_modules`、本机 `.env` 或旧构建目录，然后执行：

- `pnpm install --frozen-lockfile`：通过；独立依赖树未安装 `electron`、`electron-builder`、`electron-vite`、`electron-updater` 或 `@electron-toolkit/*`。
- `pnpm check:runtime`、`pnpm typecheck`：通过。
- `pnpm test`：176 个文件、1579 项测试通过。
- `pnpm build:web`：通过。

第一次干净验证发现两个网关请求测试隐式依赖本机 `.env`，已在测试中显式注入合成 API 地址并清理环境；第二次独立目录验证全部通过，生产后端配置规则保持原样。

主工作目录还执行了以下检查：

- 固定 vendor 校验、Go 全包测试、34 项 vendor／发布／Linux 诊断脚本测试通过。
- 官方固定 CLI 一次构建 `darwin/arm64,windows/amd64,linux/amd64` 通过；输出在 `build/mygo/electron-removed-final/`。
- macOS `.app` 的 ad hoc 签名通过 `codesign --verify --deep --strict`；Windows 生成便携 EXE；Linux 生成 ELF、DEB 和 tar.gz。已核对二进制架构及产物目录，没有发现 Electron／Node 运行时文件。
- 使用独立 Chrome 会话加载干净 Web 产物，完成首次协议、设置弹窗及播放／歌词／网络设置检查。设置交互期间给旧 `window.electron`／`window.api` 安装拒绝读取的探针，读取次数为零，页面脚本错误为零；随后关闭浏览器和测试服务。

日志位于本机 `/tmp/hemusic-electron-verified-*.log` 与 `/tmp/hemusic-electron-removal-*.log`。浏览器结果位于 `/tmp/hemusic-electron-removal-web-*.json`。

## 发布限制与后续验收

- 当前没有 NSIS，因此本机没有生成 Windows 安装器；WebView2 安装引导继续暂停。
- 当前 macOS 为 ad hoc 签名，未公证；自动更新未配置真实 feed、公钥和 CI 私钥，不能宣称已可发布或可自动更新。
- Windows 托盘左键、新托盘菜单图标、普通安装、真实业务数据迁移和更新安装链路仍需要相应平台实机验收。
- Linux 兼容模式与 X11 穿透沿用已有验证；Wayland 输入尚未验收，用户已停止排查的正常模式拖影不作为移除阻塞。
- 浏览器检查没有验证真实账号、后端音乐接口和可闻播放；Docker 镜像及 GitHub Actions 工作流尚未实际执行。

删除前的审查基线为 `27ffc7c`：当时默认命令、静态 adapter、共享分支、类型继承和发布流程仍依赖 Electron。上述配套清理已经执行；历史阶段记录继续保留在 [迁移执行记录](./mygo-migration-log.md)，不能把历史构建结果当作本轮验收证据。
