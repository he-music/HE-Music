import type { BeatFxEvent } from "./clock";

// 未接入离线分析：原版的 isBeatFxReady 防护会跳过附加节拍效果，基础烟花保持原样。
const events: readonly BeatFxEvent[] = [];
const strengths: Readonly<Record<string, number>> = {};
export const isBeatFxReady = () => false;
export const getBeatEffectStrength = (id: string) => strengths[id] ?? 0;
export const getBeatFxEvents = () => events;
export const getBeatFxIntensities = () => ({ beat: 0, downbeat: 0 });
export const getBeatFxRotationSign = () => 1;
export const getBeatFxTrackScale = () => 1;
