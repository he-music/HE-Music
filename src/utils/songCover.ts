import type { SongInfo } from "@/types/main.hemusic";
import { getCoverUrlStr } from "@/api/song";
import { useDataStore } from "@/stores/data";
import { usePlatformStore } from "@/stores/platform";

/** 根据平台支持的尺寸和当前登录信息生成歌曲封面地址。 */
export const getSizeCover = (song: SongInfo | null, size = 300) => {
  if (!song) {
    return "/images/song.jpg?asset";
  }

  const platformInfo = usePlatformStore().getPlatformInfo(song.platform);
  const imageSizes = platformInfo?.image_sizes || [];
  if (imageSizes.length > 0) {
    if (size < 0) {
      size = imageSizes[imageSizes.length - 1];
    } else {
      size = imageSizes.find((item) => item >= size) || imageSizes[imageSizes.length - 1];
    }
  }
  if (size === 0) size = 300;
  if (size < 0) size = 1000;
  const { cover = "", platform, id } = song;
  if (cover) {
    return cover.replaceAll("{x}", size.toString()).replaceAll("{y}", size.toString());
  }
  return getCoverUrlStr(platform, id, size, true, useDataStore().token);
};
