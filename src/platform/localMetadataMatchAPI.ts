import { matchSong, neteaseSongLyric } from "@/api/song";
import { romaSeparator, transSeparator } from "@/utils/lyric";
import { gatewayProxyUrl, mygoGatewayOrigin } from "./gateway";
import { loadSystemMediaArtwork } from "./systemMediaArtwork";
import type { MetadataMatchAPI, MetadataMatchCandidate } from "./localMetadataMatch";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value))
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function candidate(value: unknown): MetadataMatchCandidate | undefined {
  const raw = record(value);
  const item = record(raw.simpleSong ?? raw.songInfo ?? value);
  if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id <= 0) return;
  const title = text(item.name);
  if (!title) return;
  const artist = item.artist ?? item.artists ?? item.ar;
  const artists = (Array.isArray(artist) ? artist : [artist])
    .map((item: unknown) => text(record(item).name) || text(item))
    .filter(Boolean);
  const album = item.album ?? item.al;
  const aliases = item.alia ?? item.alias ?? item.transNames ?? item.tns;
  return {
    id: item.id,
    title,
    artists,
    album: text(album) || text(record(album).name),
    comment: Array.isArray(aliases) ? text(aliases[0]) : text(aliases),
    cover: text(record(album).picUrl) || text(item.picUrl),
  };
}

/** Same 1024 cover request rules as the legacy editor's coverSize.l. */
function matchCoverURL(source: string): string {
  const url = source.replace(/^http:/, "https:");
  if (url.endsWith(".jpg")) return `${url}?param=1024y1024`;
  if (url.endsWith("&"))
    return `${url}cl`.replace(/(thumbnail=[0-9]+y[0-9]+&cl)/, "thumbnail=1024y1024&");
  return url;
}

export interface MetadataMatchLyricSettings {
  downloadLyric: boolean;
  downloadLyricTran: boolean;
  downloadLyricRoma: boolean;
}

/** Reuses the existing API and controlled, bounded artwork resource chain. */
export function createMetadataMatchAPI(
  settings: () => MetadataMatchLyricSettings,
): MetadataMatchAPI {
  return {
    async search(query) {
      const response: unknown = await matchSong(
        query.title,
        query.artist,
        query.album,
        query.duration,
        query.md5,
      );
      const songs = record(record(response).result).songs;
      if (!Array.isArray(songs)) return [];
      const options = songs
        .slice(0, 20)
        .map(candidate)
        .filter((item) => item !== undefined);
      return options.filter(
        (item, index) => options.findIndex((other) => other.id === item.id) === index,
      );
    },
    async details(option, signal) {
      const currentSettings = settings();
      const preference = {
        downloadLyric: currentSettings.downloadLyric,
        downloadLyricTran: currentSettings.downloadLyricTran,
        downloadLyricRoma: currentSettings.downloadLyricRoma,
      };
      const response: unknown = await neteaseSongLyric(option.id);
      if (signal.aborted) throw new DOMException("Match cancelled", "AbortError");
      const lyrics = record(response);
      const translated = text(record(lyrics.tlyric).lyric);
      const romanized = text(record(lyrics.romalrc).lyric);
      const draft = {
        title: option.title,
        artists: [...option.artists],
        album: option.album,
        comment: option.comment,
        lyrics: [
          text(record(lyrics.lrc).lyric),
          preference.downloadLyric && preference.downloadLyricTran && translated
            ? [transSeparator, translated].join("\n")
            : "",
          preference.downloadLyric && preference.downloadLyricRoma && romanized
            ? [romaSeparator, romanized].join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
      if (!option.cover) return draft;
      // Only remote match artwork enters this path. No renderer file path grants.
      const cover = new URL(matchCoverURL(option.cover));
      if (!/^https?:$/.test(cover.protocol) || cover.username || cover.password)
        throw new Error("Unsupported match artwork");
      const gateway = mygoGatewayOrigin();
      if (!gateway || !gatewayProxyUrl(cover.href).startsWith(`${gateway}/__proxy?target=`))
        throw new Error("Match artwork requires the controlled gateway");
      const data = await loadSystemMediaArtwork(cover.href, signal);
      const mime = atob(data).startsWith("\x89PNG") ? "image/png" : "image/jpeg";
      return { ...draft, picture: { MIME: mime, Type: 3, Description: "", Data: data } };
    },
  };
}
