import type { LyricInfo, SongInfo } from "@/types/main.hemusic";

export function manualLyricKey({
  platform,
  id,
  path,
}: Pick<SongInfo, "id" | "platform" | "path">): string | null {
  return id && platform && platform !== "local" && !path ? JSON.stringify([platform, id]) : null;
}

export function isManualLyricKey(key: string): boolean {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string") {
      return false;
    }
    return key === manualLyricKey({ platform: value[0], id: value[1] });
  } catch {
    return false;
  }
}

export function isManualLyric(value: unknown): value is LyricInfo {
  return (
    !!value &&
    typeof value === "object" &&
    "platform" in value &&
    typeof value.platform === "string" &&
    !!value.platform &&
    "id" in value &&
    typeof value.id === "string" &&
    !!value.id &&
    "lyric" in value &&
    typeof value.lyric === "string" &&
    "trans" in value &&
    typeof value.trans === "string" &&
    "roma" in value &&
    typeof value.roma === "string"
  );
}
