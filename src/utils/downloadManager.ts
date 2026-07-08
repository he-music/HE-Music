import { useDataStore, useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { saveAs } from "file-saver";
import { cloneDeep } from "lodash-es";
import { songLyric, songUrl } from "@/api/song";
import songManager from "@/utils/songManager";
import type { SongInfo } from "@/types/main.hemusic";
import { songEqual } from "@/utils/song";
import { removeWordLyric, romaSeparator, transSeparator } from "@/utils/lyric";
import { t } from "@/i18n";

interface DownloadTask {
  song: SongInfo;
  quality: string;
}

class DownloadManager {
  private static instance: DownloadManager;
  private queue: DownloadTask[] = [];
  private isProcessing: boolean = false;

  private constructor() {}

  public static getInstance(): DownloadManager {
    if (!DownloadManager.instance) {
      DownloadManager.instance = new DownloadManager();
    }
    return DownloadManager.instance;
  }

  /**
   * 获取已下载歌曲列表
   * @returns 已下载歌曲列表
   */
  public async getDownloadedSongs(): Promise<SongInfo[]> {
    const settingStore = useSettingStore();
    if (!isElectron) return [];
    const downloadPath = settingStore.downloadPath;
    if (!downloadPath) return [];
    try {
      const songs = await window.electron.ipcRenderer.invoke("get-music-files", downloadPath);
      return songs;
    } catch (error) {
      console.error("Failed to get downloaded songs:", error);
      return [];
    }
  }

  /**
   * 添加下载任务
   * @param song 歌曲信息
   * @param quality 音质
   */
  public async addDownload(song: SongInfo, quality: string) {
    const dataStore = useDataStore();

    // 检查是否已存在
    if (dataStore.downloadingSongs.some((item) => songEqual(song, item.song))) {
      return;
    }

    // 添加到正在下载列表 (UI显示)
    dataStore.addDownloadingSong(song, quality);

    // 添加到下载队列
    this.queue.push({ song, quality });

    // 开始处理队列
    this.processQueue();
  }

  /**
   * 处理下载队列
   * 每次处理一个任务，完成后继续处理下一个
   */
  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await this.executeDownload(task.song, task.quality);
      }
    }

    this.isProcessing = false;
  }

  /**
   * 执行单个下载任务
   * @param song 歌曲信息
   * @param quality 音质
   */
  private async executeDownload(song: SongInfo, quality: string) {
    const dataStore = useDataStore();
    const settingStore = useSettingStore();

    // 监听下载进度
    let removeListener: (() => void) | null = null;

    if (isElectron) {
      const progressHandler = (
        _event: any,
        progress: {
          percent: number;
          transferredBytes: number;
          totalBytes: number;
          id?: string;
          platform?: string;
        },
      ) => {
        // 校验 ID
        if (progress.id && progress.id !== song.id && progress.platform === song.platform) return;

        const { percent, transferredBytes, totalBytes } = progress;
        const transferred = (transferredBytes / 1024 / 1024).toFixed(2) + "MB";
        const total = (totalBytes / 1024 / 1024).toFixed(2) + "MB";
        dataStore.updateDownloadProgress(
          song,
          Number((percent * 100).toFixed(1)),
          transferred,
          total,
        );
      };
      removeListener = window.electron.ipcRenderer.on("download-progress", progressHandler);
    }

    // 更新状态为下载中
    dataStore.updateDownloadStatus(song, "downloading");

    // 开始下载
    try {
      const result = await this.processDownload({
        song,
        quality,
        downloadPath: settingStore.downloadPath,
        overwrite: true,
      });

      if (isElectron && removeListener) {
        removeListener();
      }

      if (result.success) {
        // 下载成功，移除正在下载状态
        dataStore.removeDownloadingSong(song);
        window.$message.success(`${song.name} ${t("message.download_success")}`);
      } else {
        // 下载失败，保留在列表中并标记失败
        dataStore.markDownloadFailed(song);
        window.$message.error(result.message || t("message.download_fail"));
      }
    } catch (error) {
      console.error("Download failed:", error);
      if (isElectron && removeListener) removeListener();
      // 下载出错，保留在列表中并标记失败
      dataStore.markDownloadFailed(song);
      window.$message.error(t("message.download_fail"));
    }
  }

  /**
   * 处理下载逻辑
   * @param song 歌曲信息
   * @param quality 音质
   * @param downloadPath 下载路径
   * @param overwrite 是否覆盖已存在的文件
   */
  private async processDownload({
    song,
    quality,
    downloadPath,
    overwrite,
  }: {
    song: SongInfo;
    quality: string;
    downloadPath?: string;
    overwrite?: boolean;
  }): Promise<{ success: boolean; skipped?: boolean; message?: string }> {
    try {
      const settingStore = useSettingStore();
      let url = "";
      let type = "mp3";

      try {
        const link = song.links?.find((item) => item.name === quality);
        if (!link) return { success: false, message: t("download.get_url_fail") };

        const result = await songUrl(song.id, song.platform, link.quality, link.format);
        if (!result.url) {
          return { success: false, message: t("download.get_url_fail") };
        }
        url = result.url;
        type = result.format?.toLowerCase() || link.format.toLowerCase();
      } catch {
        return { success: false, message: t("download.get_url_fail") };
      }
      const infoObj = songManager.getPlayerInfoObj(song) || {
        name: song.name || "未知歌曲",
        artist: "未知歌手",
        album: "未知专辑",
      };

      const baseTitle = infoObj.name || "未知歌曲";
      const rawArtist = infoObj.artist || "未知歌手";
      const rawAlbum = infoObj.album || "未知专辑";

      const safeArtist = rawArtist.replace(/[/:*?"<>|]/g, "&");
      const safeAlbum = rawAlbum.replace(/[/:*?"<>|]/g, "&");

      const finalPath = downloadPath || settingStore.downloadPath;

      // 音乐命名格式与文件夹分类
      const { fileNameFormat, folderStrategy } = settingStore;

      let displayName = baseTitle;
      if (fileNameFormat === "artist-title") {
        displayName = `${safeArtist} - ${baseTitle}`;
      } else if (fileNameFormat === "title-artist") {
        displayName = `${baseTitle} - ${safeArtist}`;
      }

      const safeFileName = displayName.replace(/[/:*?"<>|]/g, "&");

      let targetPath = finalPath;
      if (folderStrategy === "artist") {
        targetPath = [finalPath, safeArtist].join("/");
      } else if (folderStrategy === "artist-album") {
        targetPath = [finalPath, safeArtist, safeAlbum].join("/");
      }

      // 校验下载路径
      if (finalPath === "" && isElectron) {
        return { success: false, message: t("message.please_set_download_path") };
      }

      if (isElectron) {
        const { downloadMeta, downloadCover, downloadLyric, saveMetaFile } = settingStore;
        let lyric = "";
        if (downloadLyric) {
          const lyricResult = await songLyric(song.id, song.platform);
          lyric = [
            removeWordLyric(lyricResult?.lyric) || "",
            settingStore.downloadLyricTran && lyricResult?.trans
              ? [transSeparator, removeWordLyric(lyricResult?.trans)].join("\n")
              : "",
            settingStore.downloadLyricRoma && lyricResult?.roma
              ? [romaSeparator, removeWordLyric(lyricResult?.roma)].join("\n")
              : "",
          ]
            .filter((item) => !!item)
            .join("\n\n");
        }

        const config = {
          fileName: safeFileName,
          fileType: type.toLowerCase(),
          path: targetPath,
          downloadMeta,
          downloadCover,
          downloadLyric,
          saveMetaFile,
          songData: cloneDeep(song),
          lyric,
          overwrite,
        };

        const result = await window.electron.ipcRenderer.invoke("download-file", url, config);
        if (result.status === "skipped") {
          return { success: true, skipped: true, message: result.message };
        }
        if (result.status === "error") {
          return { success: false, message: result.message || t("message.download_fail") };
        }
      } else {
        saveAs(url, `${safeFileName}.${type}`);
      }

      return { success: true };
    } catch (error) {
      console.error(`Error downloading song ${song.name}:`, error);
      return { success: false, message: t("message.download_fail") };
    }
  }

  /**
   * 移除下载任务
   * @param song 歌曲
   */
  public removeDownload(song: SongInfo) {
    const dataStore = useDataStore();
    dataStore.removeDownloadingSong(song);
    // 移除队列中的任务
    this.queue = this.queue.filter((task) => !songEqual(task.song, song));
    // TODO: 如果支持取消下载，这里应该调用取消逻辑
  }

  /**
   * 重试下载任务
   * @param song 歌曲
   */
  public retryDownload(song: SongInfo) {
    const dataStore = useDataStore();
    const task = dataStore.downloadingSongs.find((item) => songEqual(item.song, song));
    if (!task) return;

    // 重置任务状态与进度
    dataStore.updateDownloadStatus(song, "downloading");
    // 重置进度信息
    dataStore.updateDownloadProgress(song, 0, "0MB", "0MB");

    // 重置任务状态与进度
    dataStore.resetDownloadingSong(song);

    // 重新加入队列
    this.queue.push({ song: task.song, quality: task.quality });

    // 继续处理队列
    this.processQueue();
  }

  /**
   * 重试所有下载任务
   */
  public retryAllDownloads() {
    const dataStore = useDataStore();
    const songsToRetry = dataStore.downloadingSongs.map((item) => item.song);

    songsToRetry.forEach((song) => {
      this.retryDownload(song);
    });
  }
}

export default DownloadManager.getInstance();
