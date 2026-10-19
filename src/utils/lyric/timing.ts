interface TimedLyricLine {
  startTime?: number;
  endTime?: number;
}

/** 歌词按开始时间排序；返回首个 > time 的位置，includeEqual 时返回首个 >= time 的位置。 */
export function findLyricBoundary(
  lyrics: readonly TimedLyricLine[],
  time: number,
  includeEqual = false,
): number {
  let low = 0;
  let high = lyrics.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const start = lyrics[mid].startTime || 0;
    if (start > time || (includeEqual && start === time)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** 查询 [startTime, endTime) 内的行，保留最后 maxKeep 个激活行并按原顺序返回。 */
export function getActiveLyricIndices(
  lyrics: readonly TimedLyricLine[],
  time: number,
  maxKeep = Infinity,
): number[] {
  const indices: number[] = [];
  for (let i = findLyricBoundary(lyrics, time) - 1; i >= 0; i--) {
    if (time < (lyrics[i].endTime ?? Infinity)) {
      indices.push(i);
      if (indices.length >= maxKeep) break;
    }
    // 已结束的行之前仍可能有更长的重叠行，不能据此提前停止。
  }
  return indices.reverse();
}
