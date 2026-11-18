// 由 scripts/vendor-lyric-dom.mjs 从 Folia a8885a87539b92fb1149fc58ef0f033ad65ec042 导入，AGPL-3.0。
// 上游文件：src/utils/lyrics/subtitleTrackStyle.ts；修改导入脚本后重新生成。
// src/utils/lyrics/subtitleTrackStyle.ts
// Shared visual step between the rows of a dual subtitle stack (romanization + translation), so the
// shared bottom overlay and the modes that lay subtitles out inside their own lyric animation
// (Monet, Pendolo) read the same way.

// Second row of the 'both' stack is a step quieter than the first, so romanization (what you sing along to)
// leads and the translation reads as its gloss. Both rows keep the user's subtitle font, weight and scale;
// this only trims size and opacity relative to them.
export const SECONDARY_TRACK_SIZE_FACTOR = 0.88;
export const SECONDARY_TRACK_OPACITY = 0.82;
/** Fallback weight for the second row when the theme sets none; the first row falls back to 500. */
export const SECONDARY_TRACK_FONT_WEIGHT_FALLBACK = 400;
/** Gap above the second row, in em of that row's own font size. */
export const SECONDARY_TRACK_GAP_EM = 0.25;
