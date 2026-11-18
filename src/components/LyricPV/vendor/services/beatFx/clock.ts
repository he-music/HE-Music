// 仅保留上游花火场景使用的节拍事件契约；无节拍表时不启用增强效果。
export interface BeatFxEvent {
  t: number;
  kind: "beat" | "downbeat";
}
export const resolveBeatFxAccentGain = (_event: BeatFxEvent, scale: number) => scale;
