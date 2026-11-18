// 由 scripts/vendor-lyric-pv.mjs 从 Folia a8885a87539b92fb1149fc58ef0f033ad65ec042 导入，AGPL-3.0。
// 上游文件：src/components/visualizer/hanabi/hanabiRandom.ts；修改源头或导入脚本后重新生成。
// Copyright (c) 2026 chthollyphile
import { createVisualizerRng } from "../visualizerSeedHash";

// src/components/visualizer/hanabi/hanabiRandom.ts
// 花火的确定性随机数：按 key 播种的流（visualizerSeedHash 的 mulberry32）。编译、烟花事件、装饰件、逐字动画的
// 随机量全部从这里取，每帧画面只由时间决定——seek、重建、预热都不会改变画面。

export const createRng = createVisualizerRng;
