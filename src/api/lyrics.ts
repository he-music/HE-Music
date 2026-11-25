import type { LyricInfo } from "@/types/main.hemusic";
import { requestHemusic } from "@/utils/request";

export interface LyricCandidate {
  platform: string;
  id: string;
  name: string;
  artist_names?: string[];
  duration?: number;
}

interface SearchLyricsParams {
  platform: string;
  name: string;
  artist_names: string[];
  album_name?: string;
  duration: number;
}

export async function searchLyricCandidates(params: SearchLyricsParams, signal: AbortSignal) {
  const { list } = await requestHemusic<{ list?: LyricCandidate[] }>({
    url: "/v1/lyric/search",
    params,
    // Kratos 绑定重复的 artist_names，而不是 Axios 默认的 artist_names[]。
    paramsSerializer: { indexes: null },
    signal,
    skipErrorMessage: true,
  });
  const candidates = new Map<string, LyricCandidate>();
  for (const item of list ?? []) {
    if (item.platform === params.platform && item.id && !candidates.has(item.id)) {
      candidates.set(item.id, item);
    }
  }
  return [...candidates.values()];
}

export async function getLyricCandidate(
  { platform, id }: Pick<LyricCandidate, "platform" | "id">,
  signal: AbortSignal,
): Promise<LyricInfo> {
  const { info } = await requestHemusic<{ info?: LyricInfo }>({
    url: "/v1/lyric",
    params: { platform, id },
    signal,
    skipErrorMessage: true,
  });
  if (info?.platform !== platform || info.id !== id || typeof info.lyric !== "string") {
    throw new Error("歌词候选响应无效");
  }
  return { ...info, trans: info.trans ?? "", roma: info.roma ?? "" };
}
