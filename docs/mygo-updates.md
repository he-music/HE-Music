# mygo 自动更新发布

本工具对应固定 SDK `github.com/egoist/mygo v0.6.5-0.20261026063203-07ebe19ac0dc`，仅在开发机或 CI 使用 Node.js 24 和 Go 1.27.3。应用运行时不需要 Node。工具不上传、不发布 release、不安装应用，也不改现有 Electron 发布流程。

当前仓库没有 `updates` 配置，自动更新仍是**未配置／不可用**，不能当成“已检查，没有新版本”。缺少真实 feed、公钥或环境私钥时，工具必须拒绝，不会填假值或跳过验签。

## 应用内进度与重启

mygo 设置页会订阅原生更新状态。安装使用 SDK 的同一次下载、验签和替换操作；已知总大小时显示实际下载字节和百分比，总大小未知时显示已下载量和等待指示。下载达到 100% 仍可能处于校验、替换阶段，只有 SDK 安装返回成功才显示已应用。

更新完成后保留弹窗，用户可选择「重启应用」或「稍后」。只有明确点击重启才会停止文件会话、等待业务存储写入，再请求 SDK 重启；原生端复核当前页面、更新会话和已安装状态。取消或关闭弹窗不触发重启。

进度回调沿用更新会话的 owner、epoch 和 operation revision，迟到回调不能更新新会话。安装互斥仍持续到 SDK 真正返回，不因页面切换或进度达到 100% 提前解除。

## 公开配置与密钥

发布负责人应先将真实公开信息写入根目录 `mygo.json` 的 `updates` 对象：

| 字段        | 要求                                                                          |
| ----------- | ----------------------------------------------------------------------------- |
| `publicKey` | 官方 `go tool mygo keygen` 生成的公钥文本；base64 编码的 32 字节 Ed25519 公钥 |
| `github`    | 真实公开仓库的 `owner/repo`；与 `url` 二选一                                  |
| `url`       | 自有更新文件目录的 HTTPS URL；与 `github` 二选一                              |
| `tagPrefix` | GitHub 可选，默认 `v`；同仓库多个产品可使用专用前缀                           |
| `deltas`    | SDK 可选，默认 3；0 表示不下载旧版本生成 delta                                |
| `changelog` | SDK 可选，默认读取存在的 `CHANGELOG.md`；存在时必须包含本版本段落             |

工具要求明确的 `slug`、语义版本 `version` 和项目内相对输出目录 `out`。作为发布前门禁，它比 SDK 的最低配置更保守：拒绝 feed 中的凭据、查询或片段，拒绝私钥文件配置及项目外输出目录。版本、tag 前缀和历史产物保留策略由发布负责人确定，不要将测试密钥写入公开配置。

首次正式配置时，发布负责人使用官方 `go tool mygo keygen` 生成密钥，将私钥保存到密码管理器及 CI secret。该命令会写密钥文件，本工具及测试都不调用它。不要把私钥文件放进工作树，不要将私钥写进配置、命令参数、日志或构建产物。CI 只将 secret 绑定到环境变量 `MYGO_UPDATER_PRIVATE_KEY`，格式为 base64 编码的 64 字节 Ed25519 私钥。构建前工具从 seed 推导公钥，同时核对私钥后半段和公开配置。

CI 步骤可使用以下结构，环境变量直接引用 secret，不要 echo：

```yaml
env:
  MYGO_UPDATER_PRIVATE_KEY: ${{ secrets.MYGO_UPDATER_PRIVATE_KEY }}
run: node scripts/package/mygo-release.mjs --build --platform darwin/arm64
```

`PATH` 应指向批准的 Node、Go、pnpm 工具链。工具不安装依赖或升级 SDK；构建前验证 `go.mod` 的固定 SDK/tool 并禁止 `replace`，同时验证 `vendor/` 的整树摘要及已确认的 Windows 透明补丁，设置 `GOTOOLCHAIN=local`、`GOWORK=off`、`GOFLAGS=-mod=vendor`。依赖刷新使用 `pnpm vendor:refresh`，流程见 [固定 SDK 说明](../patches/mygo/README.md)。构建必须使用可信代码、依赖和前端命令。构建 stdout/stderr 不转发、不落盘，以防下游意外打印 secret；失败只输出受控说明，日志缓冲超过 16 MiB 也会失败。

## 命令

从项目根目录执行；默认模式是 `--check-only`，默认平台是 `darwin/arm64`：

```sh
node scripts/package/mygo-release.mjs --check-only
node scripts/package/mygo-release.mjs --verify-artifacts --platform darwin/arm64
node scripts/package/mygo-release.mjs --build --platform darwin/arm64
node --test scripts/package/mygo-release*.test.mjs
```

- `--check-only`：只读校验公开配置和目标，不需要私钥，不启动 Go，不检查远端可达性或本地产物。
- `--verify-artifacts`：离线校验指定目标的 manifest 和真实 archive/delta 文件，只需公钥，不启动 Go或下载。成功输出文件路径、大小及 SHA-256。
- `--build`：先校验公开配置、环境私钥匹配及固定 SDK，执行官方 `go tool mygo build -platform <目标列表>`，再必须完成同样的产物验签。构建成功却没有 manifest 仍算失败。官方构建会生成绑定并运行配置的前端命令，应使用干净的可信发布 checkout。

`--platform` 支持逗号分隔且不重复的 `darwin/arm64`、`darwin/amd64`、`darwin/universal`、`linux/arm64`、`linux/amd64`、`windows/arm64`、`windows/amd64`。目标列表仅表示命名与校验合同，不代表已完成各平台构建或实机验收。本轮没有真实构建或 Windows 程序执行。不能拿 arm64 manifest 代替 universal 或 amd64。

只要目标包含 Darwin，封装固定增加 SDK 官方参数 `-sign - -skip-notarize`，保留 ad hoc 签名且不用 Apple 开发者凭证。未添加 `-skip-dmg`，保留默认安装介质。跳过 Apple 公证不影响更新包 Ed25519 验签；Gatekeeper、目录权限、替换与重启仍需另做平台验收。

工具不接受 `--config`、`--upload` 或任意参数透传；配置只来自根目录 `mygo.json`，构建拒绝并行 `mygo.config.ts`。SDK 默认可能为 delta 读取远端旧产物，因此只有 **check-only、verify-artifacts 和 fake 测试是离线模式**。测试注入 fake spawn，绝不调用真实 Go 构建、生成绑定或下载。

## 官方产物与验签边界

官方目录为 `<out>/<goos>-<goarch>/`：

- `<slug>-<version>-<target>.tar.gz`：安装后的应用 archive。
- `update-<target>.json`：本目标 manifest。
- 可选 `<slug>-<from>-to-<version>-<target>.delta`。
- 对应目标的官方安装介质；输出根目录另有 `SHA256SUMS` 和安装脚本，以 SDK 实际输出为准。

manifest 没有自造 `target` 或 `sha256` 字段，目标由文件名及 archive URL 确定。字段沿用 SDK 的 `version`、`url`、`size`、`signature`，以及可选 `notes`、`date`、`deltas`、`previous`。工具要求版本与配置精确一致、URL 与配置及官方命名精确一致、size 与实际文件长度相等；manifest 上限 1 MiB，archive/delta 上限 1 GiB。若有 date，要求 RFC3339。URL 转义遵循 Go `url.PathEscape`，包括语义版本 build metadata 的 `+`。

签名严格为 `Ed25519(SHA256(真实文件 bytes))` 的 base64，不签原文或 JSON。每个本次 delta 必须存在并通过同样验签。工具检查普通文件、输出目录范围及读取前后元数据；验收应在无并发修改的构建目录执行。测试 archive/delta 是少量纯字节夹具，只证明 digest 验签与门禁，不证明 archive 内容或安装行为。

`previous` 是供下一次官方构建读取的远端历史引用：只检查元数据格式，不下载、不要求本地存在，不声称验证过其历史 bytes。工具不解析 archive 内容、不验证 Apple 签名或安装介质、不把 `SHA256SUMS` 当成真实性凭据，也不替代应用现有 SDK 语义版本比较。通过只表示本地 bytes 与公开密钥的官方签名匹配，不表示已上线或实机升级成功。

## 发布顺序

1. 确定真实 feed、公钥、CI secret、版本、前缀和保留策略；确认与已安装客户端内嵌的公钥/feed 衔接。
2. 在可信 checkout 中校验公开配置，注入私钥，构建并验证每个发布目标；确认 archives、deltas、manifests 和安装介质属于同次版本构建。
3. GitHub：上传官方产物到对应版本 draft release，批准后公开。默认前缀 `v` 的客户端读取 latest release；专用 `tagPrefix` 由 API 找对应前缀最新的非 draft、非 prerelease。专用前缀应关闭 “Set as latest”。SDK 官方 `go tool mygo build -upload` 能上传，但本工具不调用，也不要在验签前用它代替门禁。
4. 自有 HTTPS/S3：先上传 archives、deltas 和安装介质，再上传官方安装脚本及包含各平台的 `SHA256SUMS`，**最后上传 manifests**。保留旧 archive 和历史引用供 delta 构建使用；manifest/安装脚本应使用无缓存或重新验证策略。
5. 真实 feed、签名包替换和重启由平台验收另行确认。没有真实公开配置时继续显示更新不可用。

`package.json` 已提供以下入口，现有 Electron 命令仍保留：

```json
{
  "release:desktop:check": "node scripts/package/mygo-release.mjs --check-only",
  "release:desktop:verify": "node scripts/package/mygo-release.mjs --verify-artifacts",
  "release:desktop:build": "node scripts/package/mygo-release.mjs --build",
  "test:desktop:release": "node --test scripts/package/mygo-release*.test.mjs"
}
```
