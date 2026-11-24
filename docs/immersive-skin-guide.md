# HE-Music 沉浸皮肤制作指南

用这份指南为 HE-Music 制作一套可在主题配置中切换的沉浸皮肤。文末的提示词可直接交给能编辑本仓库的 AI。现有「冰湖晚霞」提供了一套完整的实现参考。 [皮肤定义](../src/theme/skins/iceLake.ts) · [样式变量](../src/theme/skins/iceLake.scss) · [底图](../src/assets/skins/ice-lake.webp)

## 接入一套皮肤

1. 选一个稳定、唯一的小写连字符 ID，例如 `night-aurora`。`none` 表示关闭皮肤。ID 会随设置保存，已发布的 ID 应继续保留。
2. 将底图放到 `src/assets/skins/`，例如 `night-aurora.webp`。建议使用宽幅写实风景，预留安静的文字区域，并在桌面和窄屏两种裁切下保留主要景物。以可辨认的景物细节和合适的文件体积为准调整 WebP 压缩。
3. 在 `src/theme/skins/` 增加一份 TypeScript 预设。沿用「冰湖晚霞」的 `id`、`labelKey`、`mode`、`cssVariables` 和 `themeOverrides`。`mode` 可选 `dark` 或 `light`。再将预设加入 `immersiveSkins`，设置选项、皮肤 ID 类型和持久化校验会从注册表派生。 [预设范例](../src/theme/skins/iceLake.ts) · [注册表](../src/theme/skins/index.ts) · [持久化校验](../src/platform/rendererSettings.ts)
4. 在 `src/theme/skins/` 增加一份同名 SCSS，把变量定义放在 `:root[data-skin="night-aurora"] body` 下。选择器中的 ID 应与预设一致。主窗口会自动载入这个目录第一层的 `*.scss` 文件。 [样式范例](../src/theme/skins/iceLake.scss) · [主窗口入口](../src/bootstrap/mainWindow.ts)
5. 在中英文语言文件的 `setting.general` 下添加同一个名称键，例如 `theme_skin_night_aurora`。将预设的 `labelKey` 写成完整路径 `setting.general.theme_skin_night_aurora`。启动后，通过右上角 **设置 → 主题配置 → 沉浸皮肤** 选择新皮肤。 [简体中文](../src/i18n/locales/zh-CN.json) · [English](../src/i18n/locales/en.json)

新皮肤的色值、底图、材质和交互高亮集中在自己的 `.ts` 和 `.scss`。主窗口只绘制一张底图，顶栏、侧栏、内容区和播放栏共用这张图。共享界面调整默认覆盖全部沉浸皮肤。 [共享样式](../src/style/immersiveSkin.scss)

在 [皮肤缩略图](../src/components/Modal/Setting/SkinPreview.vue) 的 `skinScenes` 中复用同一底图，让新皮肤在选择前也有缩略图。

## 变量怎么填

TypeScript 预设里的 `--skin-primary-rgb`、`--skin-base-rgb` 和 `--skin-panel-rgb` 使用逗号分隔的 RGB 通道，例如 `255, 209, 151`。`--skin-text` 和 `--skin-secondary` 使用完整 CSS 颜色。让 `themeOverrides.common` 从同一组常量取值，例如 `primaryColor` 对应主色，`bodyColor` 对应底色，`cardColor` 和 `modalColor` 对应面板色。Naive UI 的配色字段使用可解析的具体色值，例如由通道拼成的 `rgb(255, 209, 151)`。 [实现参考](../src/theme/skins/iceLake.ts)

制作 SCSS 时，可复制现有皮肤的变量区作为起点，替换下表中和新风景相关的值。保留变量名和格式即可复用组件规则。 [完整变量范例](../src/theme/skins/iceLake.scss)

| 区域 | 变量 | 调整重点 |
| --- | --- | --- |
| 底图与列表 | `--skin-scene`、`--skin-scene-scrim`、`--skin-list-scrim` | `--skin-scene` 填写一层背景，例如 `url("@/assets/skins/night-aurora.webp") 60% center / cover no-repeat`。用一张底图和一层全窗口遮罩保持画面连续，列表可以增加局部遮罩。 |
| 设置、置顶区域与边缘 | `--skin-glass-light`、`--skin-glass-deep`、`--skin-settings-surface`、`--skin-blur`、`--skin-edge`、`--skin-row-edge`、`--skin-edge-tint-rgb` | 前三项用于设置弹窗，模糊用于置顶区域。边缘色用少量风景色，最后一项使用逗号分隔的 RGB 通道。 |
| 卡片与浮层 | `--skin-card-surface`、`--skin-sticky-surface` | 前者用于搜索弹层、歌曲信息、综合搜索实体和评论等卡片。弹层的色层叠在预设的面板底色上。后者用于置顶表头等滚动区域。 |
| 列表对比与反馈 | `--skin-row-scrim-rgb`、`--skin-row-edge-opacity`、`--skin-row-center-opacity`、`--skin-row-hover-opacity`、`--skin-row-playing-edge-opacity`、`--skin-row-playing-center-opacity`、`--skin-hover`、`--skin-selected` | 行遮罩的 RGB 通道用空格分隔，不透明度在 `0` 到 `1` 之间。可单独加深悬停和播放行，避免背景亮处吞掉歌手、专辑与时长。 |
| 播放控件 | `--skin-accent`、`--skin-ink`、`--skin-rail`、`--skin-play-shine`、`--skin-focus` | 渐变集中在播放按钮和已播放进度。检查按钮图标和键盘焦点的辨识度。 |
| 音质标签 | `--skin-chip`、`--skin-master-background`、`--skin-master-text` | `SQ`、`HQ` 等沿用低调的普通标签。`MASTER` 用较深的底色与细边作轻量区分，视觉优先级低于歌名。 |
| 关于页 Markdown | `--skin-markdown-code`、`--skin-markdown-inline-code` | 正文沿用外层卡片底色，代码块、表格交替行和行内代码有各自的层次。 |

保留现有 SCSS 对 `prefers-reduced-transparency` 和 `prefers-contrast` 的处理思路，为新配色提供更实的材质和更清楚的边缘。共享规则已提供减少动态效果时的处理。

## 验收清单

- [ ] 在桌面和窄屏实际打开皮肤。检查同一张底图在顶栏、侧栏、内容区与播放栏之间是否连续。确认歌名、歌手、专辑、时长和音质标签在底图亮处仍清晰。普通文字以至少 `4.5:1` 的对比度为目标，按背景、遮罩与行状态实际叠加后的颜色检查。
- [ ] 检查默认搜索面板、搜索建议和综合搜索的匹配卡片。搜索弹层应盖住下方内容，里面的选项能点击。
- [ ] 检查歌曲详情顶部信息、视频加载层、普通视频评论和沉浸观看评论抽屉。检查「关于」中新版及历史更新日志的正文、链接、表格和代码块。
- [ ] 刷新后仍选中该皮肤。关闭后恢复原来的明暗模式或自定义背景，切回其他预设时也使用对应配色。
- [ ] 执行 `pnpm build:web`，确认底图能随生产构建加载。涉及 mygo 前端时执行 `pnpm build:desktop:frontend`，并记录实际验证的平台和场景。

## 可复制的生成提示词

将方括号中的内容替换为这次的新皮肤需求。只给出主题和强调色也可以，其余由实现者沿用这份指南。

```text
阅读 docs/immersive-skin-guide.md 和 src/theme/skins/ 下的冰湖晚霞预设，在 HE-Music 仓库中实现一套可切换的沉浸皮肤。

中文名 [深夜极光]
英文名 [Midnight Aurora]
皮肤 ID [night-aurora]
明暗模式 [dark]
底图构思 [写实雪山和深蓝夜空，青绿色极光位于画面上半部，雪山轮廓在窄屏裁切后仍可辨认]
强调色 [幽绿到青蓝，播放按钮和已播放进度使用渐变，当前歌曲用淡色高亮，MASTER 保持克制]
素材 [生成原创 WebP 底图，或使用我提供的素材路径]

按指南新增皮肤 TypeScript 预设、SCSS、底图和中英文名称，并加入皮肤注册表。把配色和材质参数留在皮肤预设中，沿用现有布局、路由和共享组件样式。

按验收清单检查桌面和窄屏效果、搜索弹层、视频评论、关于页 Markdown 和主题切换。最后给出启用入口、变更路径、预览及实际完成的验证。
```
