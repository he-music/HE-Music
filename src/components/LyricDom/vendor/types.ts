import type { Line as PVLine, Theme } from "@/components/LyricPV/vendor/types";
export type { Theme, Word } from "@/components/LyricPV/vendor/types";

// DOM 效果的上游契约；所有时间均为秒，框架类型只保留算法实际使用的字段。
export interface LyricAlternateText {
  role: "translation" | "romanization";
  text: string;
}
export interface Line extends PVLine {
  alternateTexts?: LyricAlternateText[];
}
export type SubtitleContentMode = "none" | "translation" | "romanization" | "both";
export interface PartitaTuning {
  showGuideLines: boolean;
  useSemanticLayout: boolean;
  staggerMin: number;
  staggerMax: number;
  avoidOverlap: boolean;
}
export const DEFAULT_PARTITA_TUNING: PartitaTuning = {
  showGuideLines: true,
  useSemanticLayout: true,
  staggerMin: 12,
  staggerMax: 36,
  avoidOverlap: false,
};
export interface ClassicTuning {
  enableWordRotation: boolean;
  breathingFloatMultiplier: number;
  useLegacyLayout: boolean;
  wordSpacing: number;
  avoidOverlap: boolean;
}
export interface WordLayoutConfig {
  id: string;
  x: number;
  y: number;
  rotate: number;
  scale: number;
  marginRight: string;
  alignSelf: string;
  passedRotate: number;
}
export interface LineLayoutConfig {
  justifyContent: string;
  alignItems: string;
  perspective: number;
  rowGap?: number;
  reachTop?: number;
  reachBottom?: number;
}
export interface VisualizerPreheatWindow {
  minLead: number;
  maxLead: number;
}
export interface WordMotionCustom {
  config: Pick<WordLayoutConfig, "x" | "y" | "rotate" | "scale" | "passedRotate">;
  baseColor: string;
  activeColor: string;
  duration: number;
  wordRevealMode: "normal" | "fast" | "instant";
}
export interface WordMotionTarget {
  opacity?: number;
  scale?: number;
  x?: number;
  y?: number;
  rotate?: number;
  color?: string;
  filter?: string;
  transition?: Record<string, unknown>;
  transitionEnd?: { filter: string };
}
export type Variants = Record<
  "waiting" | "active" | "passed",
  (custom: WordMotionCustom) => WordMotionTarget
>;
export interface GlowCustom {
  activeColor?: string;
  duration?: number;
  index?: number;
  total?: number;
  charStartTime?: number;
  charEndTime?: number;
  wordStartTime?: number;
  wordRevealMode?: string | null;
}
export interface GlowTarget {
  opacity: number | number[];
  color: string;
  textShadow?: string;
  filter?: string | string[];
  transition: { duration: number; times?: number[]; delay?: number; ease?: string };
}
export type GlowVariants = Record<
  "waiting" | "active" | "passed",
  (custom: GlowCustom) => GlowTarget
>;
export const createTheme = (color: string, fontFamily = "sans-serif", fontWeight = 700): Theme => ({
  name: "HE-Music",
  backgroundColor: "transparent",
  primaryColor: color,
  accentColor: color,
  secondaryColor: color,
  fontStyle: "sans",
  fontFamily,
  fontWeight,
  animationIntensity: "normal",
});
