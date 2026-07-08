import type { Link, SongInfo } from "@/types/main.hemusic";

export const songEqual = (a: SongInfo, b: SongInfo) => {
  return a?.id === b?.id && a?.platform === b?.platform;
};

export const getSongCanPlay = (a: SongInfo) => {
  return getSongCanPlayLinks(a)?.length > 0;
};

export const getSongCanDownload = (a: SongInfo) => {
  return a.links?.length > 0;
};

export const getSongCanPlayLinks = ({ links, platform }: SongInfo) => {
  const res: Link[] = [];
  links.forEach((item) => {
    const { name, format } = item;
    if (name === "96wma" || name === "dsd") {
      return;
    }
    // ape暂时不支持播放
    if (name === "ape" || format === "ape") {
      return;
    }
    // migu m4a 暂时只能在mac播放
    if (platform === "migu") {
      if (format === "m4a" || name.toUpperCase().includes("3D")) {
        return;
      }
    }
    res.push(item);
  });
  return res;
};

export const IsValidId = (id: string) => {
  return id != "" && Number(id) != 0;
};
