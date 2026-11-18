// 上游附加节拍效果的只读信号；普通音频频谱由 Vue 宿主直接交给绘光。
export const beatImpact = { get: () => 0 };
export const downbeatImpact = { get: () => 0 };
