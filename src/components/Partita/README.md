# Partita (云阶) 歌词视觉效果

Vue 版本的 Partita (云阶) 歌词展示，供播放器和设置预览共用。歌词效果由 `settingStore.lyricRenderer` 选择，播放器布局仍由现有逻辑（包括 `pureLyricMode`）控制。

## 来源与许可

阶梯排版、标尺引导线、多行错落算法、三态字级动画和发光包络移植自 [Folia](https://github.com/chthollyphile/folia-major)，原作者 chthollyphile，遵循 AGPL-3.0 许可证。

参考本地版本 `e51454cc`：

- `src/components/visualizer/partita/VisualizerPartita.tsx`
- `src/components/visualizer/partita/tuning.ts`
- `src/utils/lyrics/cjkSemanticLayout.ts`
- `src/utils/lyrics/graphemeTiming.ts`

本目录的代码实现与原项目一样遵循仓库根目录的 AGPL-3.0 许可证。

## 核心机制与特性

1. **CJK 语义分词与标点粘滞（`cjkSemanticLayout.ts`）**：
   - 消费已解析的 YRC / QRC 逐字歌词，利用 `Intl.Segmenter` 将零散的单字组织为符合人类直觉的词组，同时粘滞后置标点和英文缩写（如 `It's`、`世界。`），避免断行时标点孤立或字母断裂。
2. **确定性阶梯排版（`layout.ts`）**：
   - 基于歌曲行的时间戳作为随机种子，生成稳定而富有律动的分块行（Chunks）；
   - 行间交替采用左右错落位移（`staggerX`），构成优雅的“云阶”阶梯感；
   - 支持 LRU 布局缓存，避免高刷播放时反复计算 DOM 排版。
3. **标尺引导线（Guide Lines）**：
   - 每个 Chunk 配备现代感直角刻度线条，在歌词激活时随主题色展开并产生辉光发亮。
4. **多层次字级动画**：
   - `waiting`：轻量预入场准备态；
   - `active`：弹性放大、封面主色高亮、底层光晕展开、字符级扫光（多字符英文词），副歌扩散水波纹（Ripple）；
   - `passed`：优雅微旋转退场，保留微弱余晖。
5. **适应与跨端**：
   - 完美适配 HE-Music 半屏播放器空间与全宽纯歌词模式；
   - 支持翻译与罗马音/拼音辅助字幕联动展示；
   - 支持点击与回车直接跳转进度（Seek）。
