# GitHub 发布与 mygo 自动更新

README 保留发布入口和最短操作步骤，本文维护一次性准备、更新测试、正式发布与故障排查。以下使用仓库 `he-music/HE-Music`；在 fork 中发布时必须替换为自己的公开仓库。

当前 `mygo.json` 已配置 `v2.0.0` 的正式公钥、GitHub 更新源、`v` 前缀和完整更新包模式；公开配置校验不代表真实签名发布或在线升级已经验收。必须先手动安装一次带正确更新源和公钥的 mygo 版本，后续才能自动升级；已发布的 Electron 包也不能通过其旧 updater 自动切换到 mygo。旧数据迁移见 [数据说明](mygo-data.md)。

## 一次性准备

| 准备项 | 配置位置与用途 |
| --- | --- |
| 公开 GitHub 仓库 | 开启 Actions 和 Releases。客户端从公开 Release 下载，不携带 GitHub 私人访问令牌 |
| `VITE_API_URL` | 仓库 Settings → Secrets and variables → Actions → Repository secrets；填真实 HE-Music 后端地址 |
| `MYGO_UPDATER_PRIVATE_KEY` | 同上；填官方生成的私钥文件中的 base64 文本，不填文件路径 |
| 更新公钥、仓库、频道 | 写入 `mygo.json` 的 `updates`；公钥可以提交，私钥不能提交 |
| 版本与更新说明 | `package.json.version` 和 `mygo.json.version` 一致；存在 `CHANGELOG.md` 时需有本版本段落 |
| 构建工具链 | Node.js 24 LTS、pnpm 10.28.1、Go 1.27.3；继续使用固定 vendor，不因发布升级 SDK |
| 安装与测试环境 | 每个交付平台准备实际设备或虚拟机；Windows 需要 WebView2 Runtime，Linux 需要桌面运行依赖 |

正式发布准备只要求上述后端地址和更新私钥两个 Secrets。`VITE_NETEASE_API_URL`／`/api/netease` 是历史网易 API 的兼容入口，不作为发布必备配置；已经停用该服务时，不要求重新部署或填写这个 Secret。当前本地歌曲标签编辑器的「在线自动匹配」仍调用旧 `/search/match` 和 `/lyric/new`，没有该服务时这项功能不可用，需另行迁移或清理；日常登录、播放、在线歌词、评论与视频走 HE-Music 的 `/v1` 接口。

`VITE_*` 地址会编译进客户端，必须是可公开的服务地址，不能在其中放服务端密钥。GitHub 创建草稿 Release 使用工作流自动提供的 `GITHUB_TOKEN`，发布 job 已声明 `contents: write`；同仓库发布通常不需要另配 PAT。组织策略若拒绝写入，需由仓库管理员检查 Actions 权限。

先将发布工作流合入默认分支，Actions 页面才能使用 **Run workflow** 手动入口。tag 发布则使用该 tag 所指提交中的工作流，务必让 tag 指向已经包含本发布流程的提交。

### 生成并保存更新密钥

在项目根目录先运行 `pnpm vendor:check`。macOS／Linux 使用固定的官方 CLI：

```sh
GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=vendor go tool mygo keygen
```

Windows PowerShell 对应为：

```powershell
$env:GOWORK = "off"
$env:GOTOOLCHAIN = "local"
$env:GOFLAGS = "-mod=vendor"
go tool mygo keygen
```

命令默认把 `mygo-update.key` 和 `mygo-update.pub` 写入操作系统用户配置目录下的 `mygo/update-keys`，并显示路径；`-o` 可指定仓库外的目录。只把 `.pub` 中的公钥填入公开配置，把 `.key` 内容备份到密码管理器并保存为 Actions secret。发布后沿用同一密钥，不能每发一个版本重新生成；不要使用 `-force` 覆盖已有正式密钥。

发布负责人已生成正式密钥，并确认将私钥保存为 GitHub Secret；本地只核对公钥，不读取私钥，Secret 是否正确仍由真实签名构建验证。不要将私钥放入工作树、命令参数、日志或发布附件；项目发布脚本也禁止 `updates.privateKey`。

### 配置更新源与频道

在现有 `mygo.json` 中增加以下 `updates` 对象，保留其他窗口、图标与构建配置。公钥占位文字必须替换为真实值后才能通过检查：

```json
{
  "updates": {
    "publicKey": "替换为 mygo-update.pub 中的真实公钥",
    "github": "he-music/HE-Music",
    "tagPrefix": "v",
    "deltas": 0
  }
}
```

正式发布统一使用 `v` 前缀，从 `v2.0.0` 开始，后续为 `v2.0.1`、`v2.1.0` 等。可选测试频道单独维护：

| 用途 | `updates.tagPrefix` | tag 示例 | GitHub 发布设置 |
| --- | --- | --- | --- |
| 正式发布 | `v` | `v2.0.0` | 公开普通 Release，设置为仓库 latest |
| 更新演练 | `mygo-test-v` | `mygo-test-v2.0.0` | 公开普通 Release，不设为仓库 latest |

工作流支持上述两种 tag，并统一先生成草稿、`make_latest: false`、`prerelease: false`。正式 `v2.0.0` 公开时手动勾选 **Set as the latest release**；`v` 频道客户端从 latest release 获取更新。自定义测试前缀按 GitHub API 的发布顺序寻找匹配频道，保持非 latest。草稿和 GitHub prerelease 默认都不会被客户端检测到。

公钥、feed 和目标平台会编译进安装包。旧包不会读取 GitHub 上最新的 `mygo.json`，修改频道、公钥或仓库后需要重新构建并安装基线包。测试和正式包可以使用同一长期密钥，但各自的前缀应保持稳定；正式密钥只提供给可信构建。

首次演练保留 `deltas: 0`，先验证完整包更新。完整链路通过后可改成 `3`，生成最近版本的增量包；没有更小的 delta 时 SDK 可以只生成完整包，不代表失败。保留历史 Release、archive 和 manifest，不要覆盖同版本附件。

## 正式发布到 GitHub

1. 将准备好的代码合入正式发布分支，把 `updates.tagPrefix` 设为 `v`，确认长期公钥与 `updates.github` 正确。首次正式版本为 `v2.0.0`；若此前使用测试前缀，正式包需单独安装为正式频道的基线。
2. 同时修改 `package.json.version` 和 `mygo.json.version`，例如首次正式 mygo 使用 `2.0.0`；二者都不带 `v`。存在 `CHANGELOG.md` 或配置了 `updates.changelog` 时，加入 `## 2.0.0` 或 `## [2.0.0] - 日期` 段落。更新说明在构建时写进 manifest，仅编辑 GitHub Release 正文不会更新客户端中的说明。
3. 运行 `pnpm typecheck`、`pnpm test`、`pnpm vendor:check` 和 `pnpm release:desktop:check` 等检查，提交并推送代码，再创建版本 tag。下面的命令由发布负责人执行，本次文档工作没有执行推送：

   ```sh
   git tag v2.0.0
   git push origin v2.0.0
   ```

4. Actions 先验证 Web／Go，再构建 macOS universal、Windows amd64/arm64、Linux amd64/arm64。tag 构建必须通过公开配置、私钥匹配、当前仓库、tag 与两个版本一致性检查，然后校验真实 archive／delta 签名；失败时不会进入草稿创建步骤。
5. 打开草稿 Release，核对所有平台附件与合并后的 `SHA256SUMS`，从本次安装包完成平台安装与启动验收。macOS 当前使用 ad hoc 签名，未公证；Windows 安装包依赖 NSIS，不能把编译出 EXE 等同于安装器已验证。
6. 安装验收后公开草稿，勾选 **Set as the latest release**，保持非 prerelease。**公开并设为 latest，就是向正式频道已有客户端提供更新的时点**。首个启用更新的 mygo `v2.0.0` 需要用户手动安装；下一个更高版本才验证正式频道升级。
7. 从一个已安装的旧正式 mygo 版本复查检测、下载、安装、重启和数据保留，再记录发布结果。保留旧安装包用于恢复；发现问题时停止发布后续更新，修复后用更高版本发布，不覆盖旧 tag 或已签名文件。恢复旧程序版本也不保证新数据格式可向后兼容。

`.github/workflows/release.yml` 的手动 **Run workflow** 只生成 Actions 测试产物，不创建 Release、不公开更新。没有更新私钥的普通构建可以编入 feed／公钥，但不会生成可供发布的签名更新文件，因此不能把普通测试产物直接当作正式更新 Release。

## 先做一次 A → B 更新演练

以下版本只是示例，实际应选择频道内递增且未发布过的版本。使用单独测试分支，将 `updates.tagPrefix` 设为 `mygo-test-v`；在虚拟机或单独系统用户下验证，避免测试包使用日常数据目录。仅换 tag 前缀不会隔离本地业务数据。

1. **构建旧版 A。** 将 `package.json.version` 和 `mygo.json.version` 都设为 `2.0.0`，公钥、仓库和测试前缀配置完整，运行公开配置检查：

   ```sh
   pnpm install --frozen-lockfile
   pnpm vendor:check
   pnpm release:desktop:check
   pnpm typecheck
   pnpm test
   pnpm test:desktop:release
   ```

   保存并提交修改，推送测试分支，再创建和推送匹配 tag：

   ```sh
   git tag mygo-test-v2.0.0
   git push origin mygo-test-v2.0.0
   ```

2. **检查并发布 A 的测试草稿。** 等待 Actions 的 validate、desktop 和 release job 成功。在 GitHub Releases 中核对草稿的版本、更新清单、完整更新包与安装介质；发布为普通 Release，保持非 latest、非 prerelease。该测试 Release 会公开，但正式 `v` 客户端不会读取它。
3. **手动安装并运行 A。** macOS 把 `.app` 复制到用户可写的 `~/Applications` 后运行，不从只读 DMG 中测试；Windows 优先使用当前用户安装器，便携包应放在独立可写目录；Linux 使用 tar.gz／`install.sh` 安装到用户目录。通过 DEB 安装到系统目录的包由包管理器更新，不用于验证应用自更新。进入「设置 → 关于 → 检查更新」，确认界面版本为 A。`pnpm dev` 开发包不能用于该测试。
4. **发布新版 B。** 在同一测试分支把两个版本都改为 `2.0.1`，增加可识别的更新说明，保持公钥、前缀、slug、identifier 和架构一致。提交、推送，并创建 `mygo-test-v2.0.1`。CI 成功后，按同样方式发布 B 的普通测试 Release。B 留在草稿时，A 应继续看不到 B。
5. **从 A 发起升级。** 仍运行 A，在「设置 → 关于 → 检查更新」检测到 B 后选择立即更新。观察下载进度、验签和替换结果；达到 100% 不等于安装完成。完成后先选「稍后」，确认程序没有自行重启；再显式重启或正常退出后重开，确认实际版本变成 B。
6. **核对更新后的行为和数据。** 检查设置、收藏／歌单、下载任务、本地目录重新授权，以及播放、歌词、托盘、快捷键等实际功能。再检查更新，确认不重复提示同一个 B；较低版本不应触发自动降级。记录系统、架构、A/B 版本与结果。

至少先验证每个平台的完整包更新，再验证 delta。macOS universal 包只读取 `update-darwin-universal.json`，与 arm64／amd64 专用包不同；Windows、Linux 的 amd64 与 arm64 也各用各的清单，不能互相替代。

断网、下载失败、签名不匹配和损坏文件的回归可先运行 `pnpm test:desktop:release`；脚本夹具只证明本地门禁与验签，不能代替真实下载安装。需要手动破坏附件验证时只能使用隔离的测试频道，不能改动正式 Release。

## 需要哪些附件

官方产物位于 `build/mygo/<goos>-<goarch>/`。以 `he-music`、`2.0.0` 为例：

| 文件 | 用途 |
| --- | --- |
| `update-<target>.json` | 本平台更新清单，必须保留官方名称 |
| `he-music-2.0.0-<target>.tar.gz` | 真正供 updater 下载和替换的签名完整包，不能只上传安装器 |
| `he-music-<from>-to-2.0.0-<target>.delta` | 可选增量包，存在时需与清单一致 |
| macOS `.dmg` | 首次手动安装介质；签名发布工具保留 DMG 构建 |
| `he-music-setup-2.0.0-amd64.exe`／`arm64.exe` | Windows 当前用户安装器 |
| Linux `.deb` 和 tar.gz | 包管理器安装和用户目录安装两种方式 |
| `install.sh`／`install.ps1` | SDK 安装脚本，工作流选取对应平台的一份 |
| `SHA256SUMS` | 工作流合并各平台文件摘要，便于下载核对；不能替代 Ed25519 验签 |

GitHub 自动附带的源码 zip／tar.gz 不是应用更新包。工作流将附件上传到与 tag 同名的草稿，保持平台文件名不变；不上传原始 Windows EXE 作为安装器的替代物。NSIS 在 Windows 构建机上可由 SDK 自动下载，需允许该下载；在 macOS／Linux 交叉打 Windows 包时必须自行安装 `makensis`，否则可能只有便携 EXE。当前本机未安装 NSIS，尚无本机安装器验收结果。

## 本地发布命令与校验边界

从项目根目录运行，默认目标为 `darwin/arm64`：

```sh
pnpm release:desktop:check
pnpm release:desktop:verify --platform darwin/arm64
pnpm release:desktop:build --platform darwin/arm64
pnpm test:desktop:release
```

- `check`：只读检查公开配置和目标，不需要私钥，不访问 feed，不检查已有包。
- `verify`：离线检查本次 manifest 和真实 archive／delta 的大小与签名，只需公钥，不调用 Go 或下载。
- `build`：需要进程环境中的 `MYGO_UPDATER_PRIVATE_KEY`；使用固定官方 CLI 构建后再完成同样验签。该脚本自身不上传、不发布、不安装应用。只有 GitHub tag 工作流另外创建草稿。

工具链固定为 `github.com/egoist/mygo v0.6.5-0.20261026063203-07ebe19ac0dc`，并校验 vendor 全树及 Windows 透明补丁；构建设置 `GOTOOLCHAIN=local`、`GOWORK=off`、`GOFLAGS=-mod=vendor`。不使用模块缓存里的私改 SDK，不接受 `--config`、`--upload` 或任意参数透传，也拒绝并行 `mygo.config.ts`。维护方式见 [固定 SDK 说明](../patches/mygo/README.md)。

本地需要签名构建时，由密码管理器向进程环境提供私钥，不要把私钥粘贴到命令行。脚本不转发或落盘下游构建 stdout/stderr，避免 secret 泄露；失败只输出受控错误，输出缓冲超过 16 MiB 也会失败。SDK 的 delta 构建可能下载历史文件，只有 `check`、`verify` 和 fake 测试属于离线操作。

支持的目标为 `darwin/arm64`、`darwin/amd64`、`darwin/universal`、`windows/amd64`、`windows/arm64`、`linux/amd64`、`linux/arm64`，可用逗号分隔。包含 Darwin 时固定加 `-sign - -skip-notarize`，保留默认 DMG；这与更新包的 Ed25519 签名是两种不同的签名，跳过 Apple 公证不代表跳过更新验签。

### 签名与协议约束

私钥是 base64 编码的 64 字节 Ed25519 私钥，公钥是 base64 编码的 32 字节公钥；构建前会从 seed 推导公钥，同时核对私钥后半段及公开配置。`github` 与 HTTPS `url` 二选一；本仓库 GitHub tag 工作流要求 `github` 等于当前工作流仓库。自有 HTTPS/S3 部署不走该 GitHub 发布流程，应先上传 archive／delta／安装介质，再上传脚本和摘要，最后上传 manifest，保留历史文件，并为固定名称文件配置缓存重新验证策略。

manifest 沿用 SDK 的 `version`、`url`、`size`、`signature`，以及可选 `notes`、`date`、`deltas`、`previous`，不自造 `target` 或 `sha256` 字段。目标由文件名及 URL 确定；版本、官方 URL 和实际文件大小必须精确匹配。日期需为 RFC3339，manifest 上限 1 MiB，单个 archive／delta 上限 1 GiB；URL 转义遵循 Go `url.PathEscape`，包括版本 build metadata 的 `+`。

签名为 `Ed25519(SHA256(真实文件 bytes))` 的 base64。每个本次 delta 都必须存在并验签；读取限定普通文件和项目内输出路径，并核对读取前后元数据，验收目录不得并发修改。`previous` 仅验证历史引用格式，不下载或重新验证历史 bytes。工具不解析 archive 内容、不验证安装介质和 Apple 签名、不把 SHA256SUMS 当作真实性凭据；本地验签通过不等于已上线或完成安装验收。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 更新不可用 | 当前包未编入 updates、是开发包，或安装位置／其父目录不可写；需要安装新的基线包 |
| 测试 B 检测不到 | B 仍是草稿／prerelease、频道前缀不同、没有对应架构清单，或 B 版本不高于 A |
| 已发布但提示旧版本 | 自定义前缀按发布顺序取匹配 Release；不要在 B 之后重新公开旧的 A，也不要让其他产品共享频道 |
| GitHub 请求受限 | 自定义前缀通过公开 GitHub API 查询，共享 IP 可能触发限流；默认匿名额度通常为每小时 60 次 |
| tag 构建没有运行 | tag 不符合 `v*`／`mygo-test-v*`，或 tag 对应提交没有工作流、仓库 Actions 未开启 |
| tag／版本校验失败 | tag 必须是 `tagPrefix + version`；检查 `package.json`、`mygo.json` 和 fork 仓库名 |
| 私钥／签名不匹配 | secret 是否为私钥文本，公钥是否来自同一密钥，archive 是否被替换或下载损坏 |
| 更新说明为空或构建报缺版本段落 | 检查构建时的 CHANGELOG；修改 Release 正文不会修改已生成 manifest |
| 100% 后仍在安装 | 正在验签和替换，等待 SDK 返回；安装完成后还需显式重启才能运行新版本 |
| Windows 没有 setup EXE | 检查 NSIS 下载／`makensis`；WebView2 需已安装，引导安装能力仍暂停 |
| macOS 首次启动被系统阻止 | 当前为 ad hoc 签名且未公证；需要单独完成系统安装验收，不能把 Ed25519 更新签名当作 Apple 开发者签名 |
| DEB 安装不能自更新 | 系统目录由包管理器维护；用 DEB 升级，或用用户目录安装方式测试应用自更新 |

这套文档和离线测试不表示真实 GitHub feed、发布权限及三平台安装链路已经验收。正式发布前必须完成上述配置与实机演练。
