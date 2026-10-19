import type { LyricLine } from "@applemusic-like-lyrics/lyric";
import { findLyricBoundary, getActiveLyricIndices } from "./lyric/timing";

/** 计算桌面歌词索引；保留原有提前量、结束边界和多行保留规则。 */
export const calculateLyricIndex = (
  currentTime: number,
  lyrics: LyricLine[],
  offset: number = 0,
  maxKeep: number = 3,
): number => {
  if (!lyrics.length) return -1;
  const playSeek = currentTime + offset + 300;
  const lastLine = lyrics.at(-1)!;
  if (playSeek >= (lastLine.endTime ?? Infinity)) return lyrics.length - 1;

  if (!lyrics[0].endTime) return findLyricBoundary(lyrics, playSeek, true) - 1;
  if (playSeek < (lyrics[0].startTime || 0)) return -1;

  const active = getActiveLyricIndices(lyrics, playSeek, Math.max(maxKeep, 2));
  if (!active.length) return findLyricBoundary(lyrics, playSeek) - 1;
  if (active.length === 1) return active[0];
  const keepCount = active.length >= maxKeep ? maxKeep : 2;
  return active.at(-keepCount) ?? -1;
};
