import { useDataStore, useMusicStore, useStatusStore } from "@/stores";
import { getCoverColorData, MONOTONOUS_THEME } from "./color";
import type { CoverColors } from "@/types/main";
import type { Link, SongInfo } from "@/types/main.hemusic";
import { songUrl } from "@/api/song";

/**
 * 歌曲解锁服务器
 */

class SongManager {
  private coverRequest = 0;
  private coverThemeCache = new Map<string, CoverColors>();
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
    const request = ++this.coverRequest;
    const statusStore = useStatusStore();
    const cached = this.coverThemeCache.get(coverUrl);
    // 每次换封面立即清除旧歌配色；仅缓存成功结果，失败允许重试。
    statusStore.songCoverTheme = structuredClone(cached ?? MONOTONOUS_THEME);
    if (!coverUrl || cached) return;
    const theme = await new Promise<CoverColors | null>((resolve) => {
      const image = new Image();
      const finish = (result: CoverColors | null) => {
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        image.remove();
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), 10000);
      image.crossOrigin = "anonymous";
      image.onload = () => {
        try {
          finish(getCoverColorData(image));
        } catch {
          finish(null);
        } // 跨域画布读取失败时保留回退配色。
      };
      image.onerror = () => finish(null);
      image.src = coverUrl;
    });
    if (theme) {
      if (this.coverThemeCache.size >= 32) {
        const oldest = this.coverThemeCache.keys().next().value;
        if (oldest) this.coverThemeCache.delete(oldest);
      }
      this.coverThemeCache.set(coverUrl, theme);
      if (request === this.coverRequest) statusStore.songCoverTheme = structuredClone(theme);
    }
  };
}

export default new SongManager();
