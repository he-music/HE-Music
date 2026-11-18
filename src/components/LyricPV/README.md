# 花火、绘光与 52Hz 歌词效果

用 Vue 3 接入 Folia 的 Hanabi（花火）、Lumiere（绘光）和 52Hz 的 Pixi 8 渲染引擎，入口在播放器的歌词效果选择器和设置预览中。效果使用播放器分配的歌词区域，适配半屏歌词布局与纯歌词模式。

## 来源

上游：[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)，固定提交 `a8885a87539b92fb1149fc58ef0f033ad65ec042`，原作者 chthollyphile，AGPL-3.0。保留原版分镜、文字动画、烟花、拼贴、光场、线稿、粒子、辉光与片尾卡。导入的 TypeScript 源码位于 `vendor/`，不包含 React 组件，也不依赖 React、React DOM 或 Framer Motion。

`vendor/components/visualizer/hanabi/` 与 `lumiere/` 保存各自算法，分段、场景缓存、换歌和 Pixi 工具共享。带生成标记的文件由以下命令导入并按项目格式化，不直接修改：

```sh
node scripts/vendor-lyric-pv.mjs /path/to/folia-major
node scripts/vendor-lyric-52hz.mjs /path/to/folia-major
```

导入脚本固定提交、记录原路径，将 MotionValue 类型替换为只读数值接口，并把逐字时间生成接到现有 Partita 工具。没有生成标记的适配文件由本项目维护。

52Hz 来自同一提交的 `mods/visualizer52hz/`，七个算法文件导入为 `vendor/mods/visualizer52hz/*.ts`，补充类型与画布可用性检查，并复用 Partita 的字形切分和音节时间。`hz52/runtime.ts` 与 `history.ts` 根据原版 `stage.mjs` 改写为共享宿主契约，负责四槽字形距离场、节拍记录和资源释放，不接入 Folium 模组宿主或额外打包 Pixi。

## 与现有移植的共用逻辑

- `Partita/model.ts`：AMLL 歌词归一化、字形切分和逐字时间；`model.ts` 只在边界转换毫秒与秒。普通歌词或关闭逐字动画时不虚构卡拉 OK 时间。
- `LyricStage/useLyricPlaybackClock.ts`：沿用播放器时钟与歌曲偏移。
- `LyricStage/useStageClock.ts`：字幕只在歌词边界变化时更新，播放进度不触发整棵 Vue 组件树更新。
- `LyricStage/retireCanvasScene.ts`：与 Kinetic 共用画布延迟释放，先移除画布，再销毁 GPU 资源。
- `lyricFontConfig.ts`：沿用字体设置。
- `audioManager.getFrequencyData()`：绘光与 52Hz 消费播放器现有频谱，同一帧合并采样，不另建音频上下文。

## 运行与范围

`LyricPVStage.vue` 管理 Vue 生命周期、异步初始化取消、暂停、页面可见性、上下文丢失和字幕；`runtime.ts` 按需加载对应引擎，换歌原地交接。卸载与切换时取消未完成的初始化、歌曲准备和事件监听。

播放器与设置预览可同时持有 Pixi 实例。销毁单个实例时显式传入 `{ removeView: true, releaseGlobalResources: false }`；Pixi 8 的布尔 `true` 会同时清空全局资源池，导致其他实例仍在使用的批次失效。初始化取消、初始化失败与正常卸载均遵循同样的隔离规则。

桌面播放器开启现有 `pureLyricMode` 时，这些效果的画布铺满播放器，歌曲信息和控制栏悬浮在上面。`usePVSafeArea.ts` 只在布局或元素尺寸变化时测量上下保留空间，`viewport.ts` 将歌词构图映射到这块空间，光场、烟花和粒子仍使用整个画布。布局切换在 DOM 更新后同步读取新尺寸、提交歌词构图并立即绘制，取消旧的防抖重建任务，同时复用渲染实例和已编译分镜；不自动修改纯歌词模式的设置。手机歌词分页与设置预览沿用原有区域。

52Hz 的年轮从当前歌词轮廓按节拍向外扩散，响度决定粗细与亮度，换行后保留此前已经发出的年轮。暂停保留记录，跳转重置记录，减少动态效果时保留静态年轮。无歌词时从随机髓心生长，桌面与移动端均保留画布入口。有频谱时沿用原版节拍与响度响应；mpv 或预览未提供频谱时，用歌词时钟维持清晰的基础年轮，不伪造频谱。原生时钟的小幅校正保留记录，明确的 seeked 事件仍立即重置，包括小幅跳转。沿用原版默认扩散速度和灵敏度，不另加参数面板。

52Hz 只采样浮点距离场与历史纹理，输出到普通颜色缓冲，不要求 `EXT_color_buffer_float`。缺少该可选扩展时仍可渲染；兼容性验证应同时覆盖这种环境，以及播放器与预览的并存、离屏重建和销毁。

系统减少动态效果设置传入原版静态模式。两种效果沿用原版默认画质，关闭花火夜空底与绘光暗场底，透明叠加在播放器背景上，通用翻译、罗马音和逐字动画开关仍由现有设置控制。

透明适配还关闭花火的环境薄烟和绘光在光束之外的雾底，保留光束内部的体积光、粒子、烟花与文字辉光。补丁由 `scripts/lyric-pv-transparent.mjs` 在导入时应用；无光区域不再添加抖动亮度。半屏画布边沿逐渐透明，避免硬切接缝；纯歌词模式下画布延伸至播放器边界，不再对四周做渐隐。

本次不接入 Folia 的 AI 主题与离线节拍分析服务。`vendor/services/beatFx/` 明确表示分析未就绪，原版额外的“随拍开花／随拍推镜”保持关闭；歌词驱动的烟花、全部基本分镜和绘光实时频谱响应照常工作。

## 验证

逻辑与 Vue 生命周期测试位于本目录，保护歌词时间单位、普通歌词、纯音乐分镜、初始化取消，以及高频时钟不更新组件树而换行正常更新。实际 WebGL 画面需在浏览器中验证；现有 Kinetic 也随项目升级为 Pixi 8，AMLL 的内部依赖由其自身管理。
