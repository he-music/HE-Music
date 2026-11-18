import type { PartitaLine } from "@/components/Partita/model";
import type { Line, Theme } from "./vendor/types";

// 复用 Partita 已有的歌词归一化，只在引擎边界把毫秒转换成秒，间奏由各自分镜编排。
export function adaptPVLines(lines: PartitaLine[], wordAnimation = true): Line[] {
  return lines
    .filter((line) => !line.isInterlude && !line.background)
    .map((line) => ({
      id: line.key,
      fullText: line.fullText,
      startTime: line.startTime / 1000,
      endTime: line.endTime / 1000,
      translation: line.translation,
      romanization: line.romanization,
      isChorus: line.isChorus,
      words: line.words.map((word) => ({
        text: word.text,
        startTime: (line.timed && wordAnimation ? word.startTime : line.startTime) / 1000,
        endTime: (line.timed && wordAnimation ? word.endTime : line.startTime) / 1000,
        syllables:
          line.timed && wordAnimation
            ? word.graphemes.map((glyph) => ({
                text: glyph.char,
                startTime: glyph.startTime / 1000,
                endTime: glyph.endTime / 1000,
              }))
            : undefined,
      })),
    }));
}

export function createPVTheme(
  color: string,
  family: string,
  weight: number,
  reduced: boolean,
  safeArea?: Theme["lyricSafeArea"],
): Theme {
  return {
    name: "HE-Music",
    backgroundColor: "#10111d",
    primaryColor: "#f5f4f0",
    secondaryColor: "#aaaab5",
    accentColor: `rgb(${color})`,
    fontStyle: "sans",
    fontFamily: family,
    fontWeight: weight,
    animationIntensity: reduced ? "calm" : "normal",
    lyricsIcons: ["Flower", "Star", "Sparkles", "Heart", "Music"],
    ...(safeArea ? { lyricSafeArea: safeArea } : {}),
  };
}
