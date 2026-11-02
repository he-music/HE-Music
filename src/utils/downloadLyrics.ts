import { removeWordLyric, splitLocalLyrics } from "./lyric";

/** Downloaded files use line timestamps and original text only. */
export function toLineDownloadLyrics(value: unknown): string {
  if (typeof value !== "string") return "";
  return removeWordLyric(splitLocalLyrics(value).lyric).replace(/<\d+:\d{2}(?:[.:]\d{1,3})?>/g, "");
}
