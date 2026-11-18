import { splitLyricGraphemes } from "@/components/Partita/model";
import { buildLineGraphemeTimeline } from "../vendor/utils/lyrics/graphemeTiming";
import type { Line } from "../vendor/types";

// 52Hz 复用现有字形与音节时间；普通歌词和关闭逐字动画时整句直接点亮。
export function buildCharTimings(line: Line): ({ start: number; end: number } | null)[] {
  if (!line.words.some((word) => word.endTime > word.startTime)) {
    return splitLyricGraphemes(line.fullText).map(() => null);
  }
  return buildLineGraphemeTimeline(line).map((glyph) =>
    /\s/u.test(glyph.char) ? null : { start: glyph.startTime, end: glyph.endTime },
  );
}
