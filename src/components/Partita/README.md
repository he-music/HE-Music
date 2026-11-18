# Partita（云阶）歌词效果

云阶由 Vue 宿主接入 Folia 固定提交 `a8885a87539b92fb1149fc58ef0f033ad65ec042` 的原版排版算法，原作者 chthollyphile，AGPL-3.0。导入方式和验证范围见 [DOM 效果说明](../LyricDom/README.md)。

`PartitaLyricRail.vue` 保留播放器及设置预览接口，将 `model.ts` 的 AMLL 毫秒歌词转换为上游秒制数据，再交给 `LyricDom/GlowStage.vue`。云阶与流光共用词级三态运动、弹簧与辉光，保留块的随机缩放、阶梯位移、逐词错落及标尺引导线。

语义分词只改变显示排版，保留真实逐字时间；普通歌词不生成虚构时间。播放器保留翻译、罗马音、字体、引导线、阶梯幅度、下一句预告及点击跳转设置。文字重叠计算和容器整体缩放适应半屏歌词布局、纯歌词模式及窄屏。

旧的 `layout.ts` 保留供早期布局契约测试使用，生产播放器已使用 `LyricDom/vendor/components/visualizer/partita/partitaLayout.ts`。歌词归一化、字形时间及旧语义工具仍供现有其他效果使用。
