import axios from "axios";
import { requestHemusic } from "@/utils/request";
import type { ListSongSheetMusicResponse, SheetMusicInfo } from "@/types/main.hemusic";

// 不分页，歌曲 ID 原样传递。
export const listSongSheetMusic = (
  platform: string,
  song_id: string,
): Promise<ListSongSheetMusicResponse> =>
  requestHemusic({
    method: "GET",
    url: "/v1/song/sheet-music",
    params: { platform, song_id },
    skipErrorMessage: true,
  });

// 返回体直接为 SheetMusicInfo，不读取 info 字段。
export const getSheetMusic = (
  platform: string,
  id: string,
  song_id: string,
): Promise<SheetMusicInfo> =>
  requestHemusic({
    method: "GET",
    url: "/v1/sheet-music",
    params: { platform, id, song_id },
    skipErrorMessage: true,
  });

/** 兼容 HTTP 501 及后端错误体中的 NotImplemented 标识。 */
export function isSheetMusicNotImplemented(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status === 501) return true;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== "object") return false;
  return ["reason", "code", "message"].some((key) => {
    if (!(key in data)) return false;
    const value: unknown = Reflect.get(data, key);
    return typeof value === "string" && /^not[\s_-]*implemented$/i.test(value.trim());
  });
}
