# Monet 歌词轨道

Vue 版本的莫奈歌词效果，供播放器和设置预览共用。歌词效果与半屏歌词布局、纯歌词模式分别独立。

排版、弹簧参数、字形扫光和辉光包络来自 [Folia](https://github.com/chthollyphile/folia-major)，原作者 chthollyphile，AGPL-3.0。当前固定提交为 `a8885a87539b92fb1149fc58ef0f033ad65ec042`，导入方式和验证范围见 [DOM 效果说明](../LyricDom/README.md)。

- `model.ts` 保留 AMLL 毫秒歌词、翻译、罗马音、和声和对唱，只有真实逐字来源启用扫光。
- `upstream.ts` 在边界转换为上游秒制数据，超长解析词按原有字形时间拆为可换行单元。
- `useMonetMotion.ts` 复用上游轨道排布与测量工具，结合实际 DOM 高度适应独立的翻译、罗马音字号及语言字体。扫光按字形实际宽度推进，固定阴影的独立辉光层只改变透明度。
- `useMonetBrowse.ts` 处理滚轮、触摸浏览与 1.8 秒空闲后恢复跟随；超长当前行保留内部滚动。

点击或键盘 Enter / Space 发出毫秒 `seek`，宿主处理歌曲偏移。暂停、隐藏、减少动态效果和卸载沿用现有生命周期处理。配色继续使用封面派生颜色，不接入 AI 关键词配色或 Folia 海报与背景服务。
