# Monet 歌词轨道

Vue 版本的 Monet 歌词展示，供播放器和设置预览共用。歌词效果由 `settingStore.lyricRenderer` 选择，播放器布局仍由现有逻辑（包括 `pureLyricMode`）控制。

## 来源与许可

布局表现、远近行缩放、滚动弹簧参数和辉光包络移植自 [Folia](https://github.com/chthollyphile/folia-major)，原作者 chthollyphile，AGPL-3.0。参考本地版本 `e51454cc`：

- `src/components/visualizer/monet/MonetLyricsRail.tsx`
- `src/components/visualizer/monet/monetLyricMotion.ts`
- `src/components/visualizer/monet/monetLyricsModel.ts`

本目录的改写与原项目一样遵循仓库根目录的 AGPL-3.0 许可证。没有移植 Folia 的海报封面、装饰、音频频谱或 AI 服务。

## 接口和运行方式

- `MonetLyricRail.vue` 消费已适配歌词与稳定的 `clock: { time: Ref<number> }`；时间统一为毫秒，宿主负责应用歌曲偏移。
- `model.ts` 将 AMLL 行转换为展示数据，保留翻译、罗马音、背景人声、对唱及字形边界。只有真实逐字来源才启用扫光。
- `useMonetMotion.ts` 在结构、字体或容器变化后读取 DOM 实际尺寸，以固定 transform 轨道滚动；每帧只更新可见字形的扫光与辉光。
- `useMonetBrowse.ts` 处理滚轮、触摸浏览和 1.8 秒空闲后恢复跟随。超长当前歌词允许内部滚动。
- 点击或键盘 Enter / Space 发出 `seek`，值为歌词开始时间；宿主减去偏移并跳转播放。
- 尊重系统减少动态效果设置；隐藏时停止动画，卸载时释放观察器和帧回调。

为了适应 HE-Music 半屏空间，文本换行交给浏览器测量，超长词允许在字形间换行；取消 AI 关键词配色，统一使用封面派生颜色。当前行显示翻译和罗马音，手动浏览时也显示浏览行的辅助文本。
