# 花火与绘光歌词效果

用 Vue 3 接入 Folia 的 Hanabi（花火）和 Lumiere（绘光）Pixi 8 渲染引擎，入口在播放器的歌词效果选择器和设置预览中。效果使用播放器分配的歌词区域，适配半屏歌词布局与纯歌词模式。

## 来源

上游：[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)，固定提交 `a8885a87539b92fb1149fc58ef0f033ad65ec042`，原作者 chthollyphile，AGPL-3.0。保留原版分镜、文字动画、烟花、拼贴、光场、线稿、粒子、辉光与片尾卡。导入的 TypeScript 源码位于 `vendor/`，不包含 React 组件，也不依赖 React、React DOM 或 Framer Motion。

`vendor/components/visualizer/hanabi/` 与 `lumiere/` 保存各自算法，分段、场景缓存、换歌和 Pixi 工具共享。带生成标记的文件由以下命令导入并按项目格式化，不直接修改：

```sh
node scripts/vendor-lyric-pv.mjs /path/to/folia-major
```

导入脚本固定提交、记录原路径，将 MotionValue 类型替换为只读数值接口，并把逐字时间生成接到现有 Partita 工具。没有生成标记的适配文件由本项目维护。

## 与现有移植的共用逻辑

- `Partita/model.ts`：AMLL 歌词归一化、字形切分和逐字时间；`model.ts` 只在边界转换毫秒与秒。普通歌词或关闭逐字动画时不虚构卡拉 OK 时间。
- `LyricStage/useLyricPlaybackClock.ts`：沿用播放器时钟与歌曲偏移。
- `LyricStage/useStageClock.ts`：字幕只在歌词边界变化时更新，播放进度不触发整棵 Vue 组件树更新。
- `LyricStage/retireCanvasScene.ts`：与 Kinetic 共用画布延迟释放，先移除画布，再销毁 GPU 资源。
- `lyricFontConfig.ts`：沿用字体设置。
- `audioManager.getFrequencyData()`：绘光消费播放器现有频谱，同一帧合并采样，不另建音频上下文。

## 运行与范围

`LyricPVStage.vue` 管理 Vue 生命周期、异步初始化取消、暂停、页面可见性、上下文丢失和字幕；`runtime.ts` 按需加载对应引擎，换歌原地交接。卸载与切换时取消未完成的初始化、歌曲准备和事件监听。

桌面播放器开启现有 `pureLyricMode` 时，这两种效果的画布铺满播放器，歌曲信息和控制栏悬浮在上面。`usePVSafeArea.ts` 只在布局或元素尺寸变化时测量上下保留空间，`viewport.ts` 将歌词构图映射到这块空间，光场、烟花和粒子仍使用整个画布。布局切换在 DOM 更新后同步读取新尺寸、提交歌词构图并立即绘制，取消旧的防抖重建任务，同时复用渲染实例和已编译分镜；不自动修改纯歌词模式的设置。手机歌词分页与设置预览沿用原有区域。

系统减少动态效果设置传入原版静态模式。两种效果沿用原版默认画质，关闭花火夜空底与绘光暗场底，透明叠加在播放器背景上，通用翻译、罗马音和逐字动画开关仍由现有设置控制。

透明适配还关闭花火的环境薄烟和绘光在光束之外的雾底，保留光束内部的体积光、粒子、烟花与文字辉光。补丁由 `scripts/lyric-pv-transparent.mjs` 在导入时应用；无光区域不再添加抖动亮度。半屏画布边沿逐渐透明，避免硬切接缝；纯歌词模式下画布延伸至播放器边界，不再对四周做渐隐。

本次不接入 Folia 的 AI 主题与离线节拍分析服务。`vendor/services/beatFx/` 明确表示分析未就绪，原版额外的“随拍开花／随拍推镜”保持关闭；歌词驱动的烟花、全部基本分镜和绘光实时频谱响应照常工作。

## 验证

逻辑与 Vue 生命周期测试位于本目录，保护歌词时间单位、普通歌词、纯音乐分镜、初始化取消，以及高频时钟不更新组件树而换行正常更新。实际 WebGL 画面需在浏览器中验证；现有 Kinetic 也随项目升级为 Pixi 8，AMLL 的内部依赖由其自身管理。
