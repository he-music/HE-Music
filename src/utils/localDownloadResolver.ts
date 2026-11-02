import {
  validDownloadHTTPURL,
  type LocalDownloadResolver,
  type DownloadMetadata,
} from "../platform/localDownloadSession";
import { validLocalDownloadFormat } from "@/platform/localDownloadPersistence";
import { toLineDownloadLyrics } from "./downloadLyrics";

export interface MygoDownloadResolution {
  readonly url: string;
  readonly format: string;
  readonly metadata?: DownloadMetadata;
}

type SongDetailReader = typeof import("@/api/song").songDetail;
type SongLyricReader = typeof import("@/api/song").songLyric;

function validResolvedURL(value: unknown): value is string {
  return typeof value === "string" && validDownloadHTTPURL(value);
}

function lyricText(value: unknown): string {
  if (!value || typeof value !== "object" || !("lyric" in value)) return "";
  return typeof value.lyric === "string" ? value.lyric : "";
}

export function createMygoDownloadResolver(
  request: (
    id: string,
    platform: string,
    quality: number,
    format: string,
  ) => Promise<unknown> = async (id, platform, quality, format) => {
    const { songUrl } = await import("@/api/song");
    return songUrl(id, platform, quality, format, { skipErrorMessage: true });
  },
  readDetail: SongDetailReader = async (...args) => {
    const { songDetail } = await import("@/api/song");
    return songDetail(...args);
  },
  readLyric: SongLyricReader = async (...args) => {
    const { songLyric } = await import("@/api/song");
    return songLyric(...args);
  },
): LocalDownloadResolver {
  return async (quality, source, options): Promise<MygoDownloadResolution> => {
    try {
      const link = source.links.find((item) => item.name === quality);
      const format = link?.format.toLowerCase();
      if (!link || !format || !validLocalDownloadFormat(format)) throw new Error();
      const response = await request(source.id, source.platform, link.quality, link.format);
      if (!response || typeof response !== "object") throw new Error();
      const url = "url" in response ? response.url : undefined;
      const resolvedFormat = "format" in response ? response.format : undefined;
      if (
        !validResolvedURL(url) ||
        typeof resolvedFormat !== "string" ||
        resolvedFormat.toLowerCase() !== format
      )
        throw new Error();
      const needMetadata = options?.writeMetadata || options?.writeCover;
      const needLyrics = options?.writeLyrics;
      const [detailResult, lyricResult] = await Promise.all([
        needMetadata
          ? readDetail(source.id, source.platform).catch(() => undefined)
          : Promise.resolve(undefined),
        needLyrics
          ? readLyric(source.id, source.platform).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const rawSong =
        detailResult && typeof detailResult === "object" && "song" in detailResult
          ? detailResult.song
          : undefined;
      const song =
        rawSong && typeof rawSong === "object"
          ? (rawSong as unknown as Record<string, unknown>)
          : undefined;
      const rawArtists = Array.isArray(song?.artists) ? song.artists : [];
      const artists = rawArtists
        .map((item) => {
          if (typeof item === "string") return item;
          const record =
            item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
          return typeof record?.name === "string" ? record.name : "";
        })
        .filter(Boolean);
      const album =
        typeof song?.album === "string"
          ? song.album
          : song?.album &&
              typeof song.album === "object" &&
              "name" in song.album &&
              typeof song.album.name === "string"
            ? song.album.name
            : "";
      const captured = options?.metadata;
      const resolvedCover =
        typeof song?.cover === "string" && song.cover ? song.cover : captured?.coverURL;
      if (options?.writeCover && (!resolvedCover || !validDownloadHTTPURL(resolvedCover)))
        throw new Error("Download cover unavailable");
      const fetchedLyrics = lyricText(lyricResult);
      const metadata = {
        title: typeof song?.name === "string" ? song.name : (captured?.title ?? source.name),
        artists: artists.length ? [...artists] : [...(captured?.artists ?? [])],
        album: album || captured?.album || "",
        lyrics: toLineDownloadLyrics(fetchedLyrics || captured?.lyrics),
        ...(resolvedCover ? { coverURL: resolvedCover } : {}),
      };
      return {
        url,
        format,
        ...(needMetadata || needLyrics ? { metadata } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message === "Download cover unavailable") throw error;
      throw new Error("Download source unavailable");
    }
  };
}
