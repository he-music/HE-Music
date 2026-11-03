import { useSettingStore } from "@/stores";
import { saveAs } from "file-saver";
import { songUrl } from "@/api/song";
import songManager from "@/utils/songManager";
import type { SongInfo } from "@/types/main.hemusic";
import { t } from "@/i18n";

/** Web 下载交给浏览器；桌面下载由 NativeFiles 的持久任务队列负责。 */
class DownloadManager {
  public async downloadInBrowser(
    song: SongInfo,
    quality: string,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const link = song.links?.find((item) => item.name === quality);
      if (!link) return { success: false, message: t("download.get_url_fail") };
      const result = await songUrl(song.id, song.platform, link.quality, link.format).catch(
        () => null,
      );
      if (!result?.url) return { success: false, message: t("download.get_url_fail") };
      const type = result.format?.toLowerCase() || link.format.toLowerCase();
      const info = songManager.getPlayerInfoObj(song) || {
        name: song.name || "未知歌曲",
        artist: "未知歌手",
        album: "未知专辑",
      };
      const title = info.name || "未知歌曲";
      const artist = (info.artist || "未知歌手").replace(/[/:*?"<>|]/g, "&");
      const { fileNameFormat } = useSettingStore();
      const displayName =
        fileNameFormat === "artist-title"
          ? `${artist} - ${title}`
          : fileNameFormat === "title-artist"
            ? `${title} - ${artist}`
            : title;
      const filename = displayName.replace(/[/:*?"<>|]/g, "&");
      saveAs(result.url, `${filename}.${type}`);
      return { success: true };
    } catch (error) {
      console.error(`Error downloading song ${song.name}:`, error);
      return { success: false, message: t("message.download_fail") };
    }
  }
}

export default new DownloadManager();
