import type { SongInfo } from "@/types/main.hemusic";
import type { SettingState } from "@/stores/setting";
import type { DirectoryGrant } from "@/platform/mygo.bindings";
import type { DownloadOptions, DownloadResolveOptions } from "@/platform/localDownloadSession";

export function sanitizeDownloadSegment(value: string): string {
  return (
    value
      .replace(/^[.\\/]+/u, "_")
      .replace(/[\\/:<>"|?*\p{Cc}]/gu, "_")
      .replace(/[. ]+$/g, "")
      .trim() || "unknown"
  );
}

function truncateUTF8(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    const next = result + character;
    if (new TextEncoder().encode(next).length > maxBytes) break;
    result = next;
  }
  return result;
}

function avoidReservedDeviceName(value: string): string {
  const firstComponent = value.split(".", 1)[0].replace(/[. ]+$/g, "");
  return /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i.test(firstComponent)
    ? `_${value}`
    : value;
}

export function normalizePortableFilename(value: string, extension: string): string {
  const suffix = `.${extension.toLowerCase().replace(/^\.+/u, "")}`;
  const base = avoidReservedDeviceName(sanitizeDownloadSegment(value));
  return `${truncateUTF8(base, Math.max(1, 240 - new TextEncoder().encode(suffix).length))}${suffix}`;
}

export function normalizePortableDirectory(segments: readonly string[]): string | undefined {
  const normalized = segments.map((segment) =>
    truncateUTF8(avoidReservedDeviceName(sanitizeDownloadSegment(segment)), 120),
  );
  if (normalized.some((segment) => !segment)) return undefined;
  let result = normalized.join("/");
  while (new TextEncoder().encode(result).length > 240) {
    const lastSlash = result.lastIndexOf("/");
    const prefix = lastSlash >= 0 ? result.slice(0, lastSlash + 1) : "";
    const last = lastSlash >= 0 ? result.slice(lastSlash + 1) : result;
    const shortened = truncateUTF8(
      last,
      Math.max(1, 239 - new TextEncoder().encode(prefix).length),
    );
    result = `${prefix}${shortened}`;
    if (shortened === last) break;
  }
  return result;
}
function names(value: SongInfo["artists"]): string[] {
  if (Array.isArray(value))
    return value.map((item) => (typeof item === "string" ? item : item.name));
  return value ? [value] : [];
}

function albumName(value: SongInfo["album"]): string {
  return typeof value === "string" ? value : (value?.name ?? "");
}

export interface LocalDownloadPlan {
  readonly filenameStem: string;
  readonly options: DownloadOptions;
  readonly resolveOptions: DownloadResolveOptions;
}

export function createLocalDownloadPlan(
  song: SongInfo,
  settings: Pick<
    SettingState,
    | "fileNameFormat"
    | "folderStrategy"
    | "downloadMeta"
    | "downloadCover"
    | "downloadLyric"
    | "saveMetaFile"
    | "downloadKeepAudioOnMetadataFailure"
  >,
): LocalDownloadPlan {
  const artists = names(song.artists);
  const artist = artists.length ? artists.join("、") : "unknown";
  const album = albumName(song.album);
  const title = song.name;
  const filenameStem =
    settings.fileNameFormat === "title"
      ? title
      : settings.fileNameFormat === "artist-title"
        ? `${artist} - ${title}`
        : `${title} - ${artist}`;
  const relativeDirectory =
    settings.folderStrategy === "artist"
      ? normalizePortableDirectory([artist])
      : settings.folderStrategy === "artist-album"
        ? normalizePortableDirectory([artist, album])
        : undefined;
  const writeMetadata = settings.downloadMeta;
  return {
    filenameStem: sanitizeDownloadSegment(filenameStem),
    resolveOptions: {
      writeLyricTranslation: false,
      writeLyricRomaji: false,
    },
    options: {
      ...(relativeDirectory ? { relativeDirectory } : {}),
      writeMetadata,
      keepAudioOnMetadataFailure: settings.downloadKeepAudioOnMetadataFailure,
      writeCover: writeMetadata && settings.downloadCover,
      writeLyrics: writeMetadata && settings.downloadLyric,
      saveSidecars: writeMetadata && settings.saveMetaFile,
      metadata: {
        title,
        artists: [...artists],
        album,
        lyrics: "",
      },
    },
  };
}

export function defaultGrantIndex(grants: readonly DirectoryGrant[], displayPath: string): number {
  const index = grants.findIndex((grant) => grant.displayPath === displayPath);
  return index;
}
