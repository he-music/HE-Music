// src/components/LyricStage/interludes.ts — Folia 的六点间奏规则，时间统一使用毫秒。
// Adapted from Folia (chthollyphile), AGPL-3.0: utils/lyrics/parserCore.ts / attachInterludes.
export interface InterludeLine {
  key: string;
  text: string;
  startTime: number;
  endTime: number;
  timed: true;
  isInterlude: true;
  words: {
    text: string;
    startTime: number;
    endTime: number;
    graphemes: { char: string; startTime: number; endTime: number }[];
  }[];
}

function createInterlude(startTime: number, endTime: number): InterludeLine {
  const step = (endTime - startTime) / 6;
  return {
    key: `interlude:${startTime}:${endTime}`,
    text: "......",
    startTime,
    endTime,
    timed: true,
    isInterlude: true,
    words: Array.from({ length: 6 }, (_, index) => {
      const start = startTime + index * step;
      const end = index === 5 ? endTime : startTime + (index + 1) * step;
      return {
        text: ".",
        startTime: start,
        endTime: end,
        graphemes: [{ char: ".", startTime: start, endTime: end }],
      };
    }),
  };
}

/** 已规范化的歌词才能判断真实空档；不推测 LRC 句尾，也不在曲终补点。 */
export function insertInterludes<T>(
  lines: T[],
  timing: (line: T) => { startTime: number; endTime: number },
  adapt: (line: InterludeLine) => T,
): T[] {
  if (!lines.length) return lines;
  const result: T[] = [];
  const first = timing(lines[0]);
  if (first.startTime > 3000) result.push(adapt(createInterlude(500, first.startTime - 500)));
  let coveredUntil = first.endTime;
  lines.forEach((line, index) => {
    result.push(line);
    coveredUntil = Math.max(coveredUntil, timing(line).endTime);
    const next = lines[index + 1];
    if (next && timing(next).startTime - coveredUntil > 3000) {
      result.push(adapt(createInterlude(coveredUntil + 50, timing(next).startTime - 50)));
    }
  });
  return result;
}
