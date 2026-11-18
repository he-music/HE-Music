import type { LumiereSceneTuning } from "./components/visualizer/lumiere/types";
import type { LineRenderHints } from "./utils/lyrics/renderHints";

// Folia 纯渲染引擎所需的契约。播放时间以秒表示，由 Vue 宿主适配现有毫秒时钟。
export interface MotionValue<T> {
  get(): T;
}
export interface Word {
  text: string;
  startTime: number;
  endTime: number;
  syllables?: { text: string; startTime: number; endTime: number }[];
}
export interface Line {
  words: Word[];
  startTime: number;
  endTime: number;
  fullText: string;
  translation?: string;
  romanization?: string;
  id?: string;
  agentId?: string;
  songPart?: string;
  blockIndex?: number;
  renderHints?: LineRenderHints;
  isChorus?: boolean;
  wordSegments?: string[];
  autoWordSegments?: string[];
}
export interface Theme {
  name: string;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  secondaryColor: string;
  fontStyle: "sans" | "serif" | "mono";
  fontFamily?: string;
  fontFamilyStack?: string[];
  fontWeight?: number;
  animationIntensity: "calm" | "normal" | "chaotic";
  wordColors?: { word: string; color: string }[];
  lyricsIcons?: string[];
  lyricSafeArea?: { top: number; bottom: number };
}
export type LyricRenderScale = 0.5 | 0.75 | 1 | 1.5 | 2;
export type LyricAntialias = "auto" | "on" | "off";
export interface LyricRenderQuality {
  scale: LyricRenderScale;
  antialias: LyricAntialias;
}
export interface LyricRenderOverride {
  scale: "global" | LyricRenderScale;
  antialias: "global" | "on" | "off";
}
export type LumiereRenderQuality = "full" | "balanced" | "low";
export interface LumiereTuning extends LumiereSceneTuning {
  render: LyricRenderOverride;
  seamlessTransitions: boolean;
  renderQuality: LumiereRenderQuality;
}
export interface AudioBands {
  bass: MotionValue<number>;
  mid: MotionValue<number>;
  treble: MotionValue<number>;
  vocal: MotionValue<number>;
}
