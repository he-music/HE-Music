import { useDataStore, useMusicStore, useStatusStore } from "@/stores";
import { getCoverColorData } from "./color";
import type { Link, SongInfo } from "@/types/main.hemusic";
import { songUrl } from "@/api/song";

/**
 * 歌曲解锁服务器
 */

class SongManager {
  /**
   * 获取当前播放歌曲
   * @returns 当前播放歌曲
   */
  public getPlaySongData = (): SongInfo | null => {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 若为私人FM
    if (statusStore.radioMode) {
      return musicStore.radioSong;
    }
    // 播放列表
    const playlist = dataStore.playList;
    if (!playlist.length) return null;
    return playlist[statusStore.playIndex];
  };

  /**
   * 获取播放信息对象
   * @param song 歌曲
   * @param sep 分隔符
   * @returns 播放信息对象
   */
  public getPlayerInfoObj = (
    song?: SongInfo,
    sep: string = "/",
  ): { name: string; artist: string; album: string } | null => {
    const playSongData = song || this.getPlaySongData();
    if (!playSongData) return null;

    // 标题
    const name = `${playSongData.name || "未知歌曲"}`;
    // 歌手
    const artist = Array.isArray(playSongData.artists)
      ? playSongData.artists.map((artists: { name: string }) => artists.name).join(sep)
      : String(playSongData?.artists || "未知歌手");

    // 专辑
    const album =
      typeof playSongData.album === "object"
        ? playSongData.album.name
        : String(playSongData.album || "未知专辑");

    return { name, artist, album };
  };

  /**
   * 获取播放信息
   * @param song 歌曲
   * @param sep 分隔符
   * @returns 播放信息
   */
  public getPlayerInfo = (song?: SongInfo, sep: string = "/"): string | null => {
    const info = this.getPlayerInfoObj(song, sep);
    if (!info) return null;
    return `${info.name} - ${info.artist}`;
  };

  public getOnlineUrl = async (
    id: string,
    platform: string,
    link?: Link,
  ): Promise<string | null> => {
    const res = await songUrl(id, platform, link?.quality, link?.format);
    console.log(`🌐 ${id} music data:`, res);
    const songData = res;
    // 是否有播放地址
    if (!songData || !songData?.url) return null;
    // 返回歌曲地址
    // 都返回 原始地址
    // const url = isElectron ? songData.url : songData.url.replace(/^http:/, "https:");
    return songData.url;
  };

  /**
   * 获取歌曲封面颜色数据
   * @param coverUrl 歌曲封面地址
   */
  public getCoverColor = async (coverUrl: string) => {
    if (!coverUrl) return;
    const statusStore = useStatusStore();
    // 创建图像元素
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = coverUrl;
    // 图像加载完成
    image.onload = () => {
      // 获取图片数据
      const coverColorData = getCoverColorData(image);
      if (coverColorData) statusStore.songCoverTheme = coverColorData;
      // 移除元素
      image.remove();
    };
  };
}

export default new SongManager();
