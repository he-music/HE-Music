// src/components/Classic/types.ts
// Folia Classic (Luminous) visualizer data types for HE-Music.
// Adapted from Folia (chthollyphile, AGPL-3.0).

export interface ClassicWordGrapheme {
  char: string;
  startTime: number; // 毫秒
  endTime: number; // 毫秒
}

export interface ClassicWord {
  text: string;
  startTime: number; // 毫秒
  endTime: number; // 毫秒
  graphemes: ClassicWordGrapheme[];
}

export interface ClassicWordLayoutConfig {
  id: string;
  x: number;
  y: number;
  rotate: number; // 度数
  scale: number;
  marginRight: string;
  passedRotate: number;
}

export interface ClassicLineLayoutConfig {
  justifyContent: "center" | "flex-start" | "flex-end" | "space-around" | "space-between";
  alignItems: "center" | "flex-start" | "flex-end";
  perspective: number;
}

export interface ClassicLine {
  key: string;
  text: string;
  translation?: string;
  romanization?: string;
  startTime: number; // 毫秒
  endTime: number; // 毫秒
  words: ClassicWord[];
  timed: boolean;
  isChorus?: boolean;
  isInterlude?: boolean;
}

export type ClassicWordStatus = "waiting" | "active" | "passed";

export interface ClassicTuning {
  enableWordRotation: boolean;
  breathingFloatMultiplier: number;
  wordSpacing: number;
  showUpcoming: boolean;
}

export const DEFAULT_CLASSIC_TUNING: ClassicTuning = {
  enableWordRotation: true,
  breathingFloatMultiplier: 1.0,
  wordSpacing: 0.7,
  showUpcoming: true,
};
