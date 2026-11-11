import { searchSong } from "@/api/search";
import type { SongInfo } from "@/types/main.hemusic";
import type { MetadataMatchAPI, MetadataMatchCandidate } from "./localMetadataMatch";

const MATCH_CANDIDATE_LIMIT = 10;

function candidate(song: SongInfo): MetadataMatchCandidate | undefined {
  if (typeof song.id !== "string" || !song.id.trim() || !song.platform || !song.name?.trim())
    return;
  return {
    id: song.id,
    platform: song.platform,
    title: song.name,
    artists:
      typeof song.artists === "string"
        ? [song.artists].filter(Boolean)
        : (song.artists ?? []).map((artist) => artist.name).filter(Boolean),
    album: typeof song.album === "string" ? song.album : (song.album?.name ?? ""),
    comment: song.alias || song.subtitle || undefined,
    cover: song.cover || "",
  };
}

/** 匹配入口只搜索候选，不再获取歌曲详情或加载候选资源。 */
export function createMetadataMatchAPI(): MetadataMatchAPI {
  return {
    async search(query, signal) {
      const key = [query.title.trim(), query.artist.trim()].filter(Boolean).join(" ");
      if (!key || !query.platform) return [];
      const response = await searchSong(key, MATCH_CANDIDATE_LIMIT, 1, query.platform, {
        signal,
        skipErrorMessage: true,
      });
      const options = response.list.map((item) => candidate(item.song)).filter((item) => !!item);
      return options
        .filter(
          (item, index) =>
            options.findIndex(
              (other) => other.id === item.id && other.platform === item.platform,
            ) === index,
        )
        .slice(0, MATCH_CANDIDATE_LIMIT);
    },
  };
}
