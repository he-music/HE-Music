import { resolveKineticJumpGranularity } from "./kinetic";

// src/utils/lyric/renderer.ts — 歌词效果选择及旧设置迁移。
export type LyricRenderer = "default" | "amll" | "monet" | "partita" | "classic" | "kinetic";

export function resolveLyricRenderer(value: unknown, legacyAMLL?: unknown): LyricRenderer {
  if (
    value === "default" ||
    value === "amll" ||
    value === "monet" ||
    value === "partita" ||
    value === "classic" ||
    value === "kinetic"
  )
    return value;
  return legacyAMLL === true ? "amll" : "default";
}

/** 在持久化数据合入默认状态前迁移，避免默认值覆盖旧用户的 AMLL 选择。 */
export function deserializeLyricSettings(serialized: string): Record<string, unknown> {
  const data = JSON.parse(serialized);
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const { useAMLyrics, ...settings } = data;
  if ("kineticJumpGranularity" in settings) {
    settings.kineticJumpGranularity = resolveKineticJumpGranularity(
      settings.kineticJumpGranularity,
    );
  }
  return { ...settings, lyricRenderer: resolveLyricRenderer(data.lyricRenderer, useAMLyrics) };
}
