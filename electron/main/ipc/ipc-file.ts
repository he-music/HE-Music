import { app, BrowserWindow, DownloadItem, dialog, ipcMain, shell } from "electron";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { access, mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { getFileID, getFileMD5, parseFile } from "../utils/helper";
import { File, Picture, TagTypes } from "node-taglib-sharp";
import { ipcLog } from "../logger";
import { download } from "electron-dl";
import { Options as GlobOptions } from "fast-glob/out/settings";
import FastGlob from "fast-glob";
import { t } from "../i18n";

/**
 * 文件相关 IPC
 */
const initFileIpc = (): void => {
  /**
   * 获取全局搜索配置
   * @param cwd 当前工作目录
   */
  const globOpt = (cwd?: string): GlobOptions => ({
    cwd,
    caseSensitiveMatch: false,
  });

  // 默认文件夹
  ipcMain.handle(
    "get-default-dir",
    (_event, type: "documents" | "downloads" | "pictures" | "music" | "videos"): string => {
      return app.getPath(type);
    },
  );

  // 遍历音乐文件
  ipcMain.handle("get-music-files", async (_, dirPath: string) => {
    try {
      // 校验路径有效性
      if (!dirPath || dirPath.trim() === "") {
        ipcLog.warn("⚠️ Empty directory path provided, skipping");
        return [];
      }
      // 规范化路径
      const filePath = resolve(dirPath).replace(/\\/g, "/");
      // 检查目录是否存在
      try {
        await access(filePath);
      } catch {
        ipcLog.warn(`⚠️ Directory not accessible: ${filePath}`);
        return [];
      }
      console.info(`📂 Fetching music files from: ${filePath}`);
      // 音乐文件扩展名
      const musicExtensions = [
        "mp3",
        "wav",
        "flac",
        "aac",
        "webm",
        "m4a",
        "mp4",
        "ogg",
        "aiff",
        "aif",
        "ape",
      ];
      // 查找指定目录下的所有音乐文件
      const musicFiles = await FastGlob(`**/*.{${musicExtensions.join(",")}}`, globOpt(filePath));
      // 解析元信息
      const metadataPromises = musicFiles.map(async (file) => {
        const fullPath = join(dirPath, file);
        try {
          // 处理元信息
          const file = parseFile(fullPath);
          // 获取文件大小
          const { size } = await stat(fullPath);
          // 判断音质等级
          let quality: string = "";
          const { lossless, bitsPerSample = 0, sampleRate = 0, bitrate = 0 } = file;
          // 判断是否为 HI-Res
          // 母带质量判断：采样率大于 384 kHz 或者位深度大于 32 位浮动
          if (sampleRate > 384000 || bitsPerSample >= 32) {
            quality = "MASTER"; // Master Quality
          } else if ((sampleRate > 44100 || bitsPerSample > 16) && lossless) {
            quality = "HIRES"; // High-Resolution
          } else if (lossless) {
            quality = "SQ";
          } else if (bitrate >= 192) {
            quality = "HQ"; // High Quality
          }
          return {
            id: getFileID(fullPath),
            name: file.title || basename(fullPath),
            artists: file.artists?.join(" / ") || "",
            album: file.album || "",
            alia: file.alia,
            duration: file.duration ?? 0,
            size: size,
            path: fullPath,
            bitrate,
            quality,
          };
        } catch (err) {
          ipcLog.warn(`⚠️ Failed to parse file: ${fullPath}`, err);
          return null;
        }
      });
      const metadataResults = await Promise.all(metadataPromises);
      // 过滤掉解析失败的文件
      return metadataResults.filter((item) => item !== null);
    } catch (error) {
      ipcLog.error("❌ Error fetching music metadata:", error);
      return [];
    }
  });

  // 获取音乐元信息
  ipcMain.handle("get-music-metadata", async (_, path: string) => {
    try {
      const filePath = resolve(path).replace(/\\/g, "/");
      const file = parseFile(filePath);
      return {
        // 文件名称
        filename: basename(filePath),
        name: file.title || "",
        artists: file.artists || [],
        album: file.album || "",
        alia: file.alia || "",
        duration: file.duration,
        channels: file.channels,
        codec: file.codec,
        bitsPerSample: file.bitsPerSample,
        sampleRate: file.sampleRate,
        bitrate: file.bitrate,
        lyrics: file.lyrics,
        pictures: file.pictures.map((picture) => ({
          data: Buffer.from(picture.data.toByteVector().toByteArray()).buffer,
          format: picture.mimeType,
        })),
        // 文件大小
        size: (await stat(filePath)).size,
        // md5
        md5: await getFileMD5(filePath),
      };
    } catch (error) {
      ipcLog.error("❌ Error fetching music metadata:", error);
      throw error;
    }
  });

  // 修改音乐元信息
  ipcMain.handle("set-music-metadata", async (event, path: string, metadata: any) => {
    // 获取窗口
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    let coverDownload: DownloadItem | null = null;
    try {
      const { name, artists, album, alia, lyrics, cover } = metadata;
      // 规范化路径
      const songPath = resolve(path);
      if (cover && cover.startsWith("http")) {
        coverDownload = await download(win, cover);
      }

      const coverPath = coverDownload ? coverDownload.getSavePath() : cover ? resolve(cover) : null;
      // 读取歌曲文件
      const songFile = File.createFromPath(songPath);
      // 读取封面文件
      const songCover = coverPath ? Picture.fromPath(coverPath) : null;
      // 保存元数据
      // Id3v2Settings.forceDefaultVersion = true;
      // Id3v2Settings.defaultVersion = 3;
      songFile.tag.title = name || "未知曲目";
      songFile.tag.performers = artists;
      songFile.tag.album = album || "未知专辑";
      songFile.tag.albumArtists = artists;
      songFile.tag.lyrics = lyrics || "";
      songFile.tag.description = alia || "";
      songFile.tag.comment = alia || "";
      if (songCover) songFile.tag.pictures = [songCover];
      // 保存元信息
      songFile.save();
      songFile.dispose();
      return true;
    } catch (error) {
      ipcLog.error("❌ Error setting music metadata:", error);
      throw error;
    } finally {
      if (coverDownload) await unlink(coverDownload.getSavePath());
    }
  });

  // 获取音乐歌词 先读取本地.lrc 再读取元数据
  ipcMain.handle("get-music-lyric", async (_, musicPath: string): Promise<string> => {
    try {
      const filePath = resolve(musicPath).replace(/\\/g, "/");
      const lrcFilePath = filePath.replace(/\.[^.]+$/, ".lrc");
      try {
        await access(lrcFilePath);
        const lrcData = await readFile(lrcFilePath, "utf-8");
        if (lrcData && lrcData != "") return lrcData;
      } catch {
        /* empty */
      }
      const { lyrics } = parseFile(filePath);
      if (lyrics) return lyrics;
    } catch (error) {
      ipcLog.error("❌ Error fetching music lyric:", error);
      throw error;
    }
    return "";
  });
  // 获取音乐封面
  ipcMain.handle(
    "get-music-cover",
    async (_, path: string): Promise<{ data: ArrayBuffer; format: string } | null> => {
      try {
        const { pictures } = parseFile(path);
        // 获取封面数据
        const picture = pictures?.[0];
        if (picture) {
          return { data: Buffer.from(picture.data.toByteArray()).buffer, format: picture.mimeType };
        } else {
          const coverFilePath = path.replace(/\.[^.]+$/, ".jpg");
          try {
            await access(coverFilePath);
            const coverData = await readFile(coverFilePath);
            return { data: new Uint8Array(coverData).buffer, format: "image/jpeg" };
          } catch {
            return null;
          }
        }
      } catch (error) {
        console.error("❌ Error fetching music cover:", error);
        throw error;
      }
    },
  );

  // 读取本地歌词
  ipcMain.handle(
    "read-local-lyric",
    async (_, lyricDir: string, id: number, ext: string): Promise<string> => {
      const lyricPath = join(lyricDir, `${id}.${ext}`);
      try {
        await access(lyricPath);
        const lyric = await readFile(lyricPath, "utf-8");
        if (lyric) return lyric;
      } catch {
        /* empty */
      }
      return "";
    },
  );

  // 删除文件
  ipcMain.handle("delete-file", async (_, path: string) => {
    try {
      // 规范化路径
      const resolvedPath = resolve(path);
      // 检查文件是否存在
      try {
        await access(resolvedPath);
      } catch {
        throw new Error("❌ File not found");
      }
      // 删除文件
      await unlink(resolvedPath);
      return true;
    } catch (error) {
      ipcLog.error("❌ File delete error", error);
      return false;
    }
  });

  // 打开文件夹
  ipcMain.on("open-folder", async (_, path: string) => {
    try {
      // 规范化路径
      const resolvedPath = resolve(path);
      // 检查文件夹是否存在
      try {
        await access(resolvedPath);
      } catch {
        throw new Error("❌ Folder not found");
      }
      // 打开文件夹
      shell.showItemInFolder(resolvedPath);
    } catch (error) {
      ipcLog.error("❌ Folder open error", error);
      throw error;
    }
  });

  // 图片选择窗口
  ipcMain.handle("choose-image", async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
      });
      if (!filePaths || filePaths.length === 0) return null;
      return filePaths[0];
    } catch (error) {
      ipcLog.error("❌ Image choose error", error);
      return null;
    }
  });

  // 路径选择窗口
  ipcMain.handle("choose-path", async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog({
        title: t("common.choose_folder"),
        defaultPath: app.getPath("downloads"),
        properties: ["openDirectory", "createDirectory"],
        buttonLabel: t("common.choose_folder"),
      });
      if (!filePaths || filePaths.length === 0) return null;
      return filePaths[0];
    } catch (error) {
      ipcLog.error("❌ Path choose error", error);
      return null;
    }
  });

  // 下载文件
  ipcMain.handle(
    "download-file",
    async (
      event,
      url: string,
      options: {
        fileName: string;
        fileType: string;
        path: string;
        downloadMeta?: boolean;
        downloadCover?: boolean;
        downloadLyric?: boolean;
        saveMetaFile?: boolean;
        lyric?: string;
        songData?: any;
        overwrite?: boolean;
      } = {
        fileName: "未知文件名",
        fileType: "mp3",
        path: app.getPath("downloads"),
      },
    ): Promise<{ status: "success" | "skipped" | "error"; message?: string }> => {
      try {
        // 获取窗口
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return { status: "error", message: "Window not found" };
        // 获取配置
        const {
          fileName,
          fileType,
          path,
          lyric,
          downloadMeta,
          downloadCover,
          downloadLyric,
          saveMetaFile,
          songData,
          overwrite,
        } = options;
        // 规范化路径
        const downloadPath = resolve(path);
        // 检查文件夹是否存在
        try {
          await access(downloadPath);
        } catch {
          await mkdir(downloadPath, { recursive: true });
        }

        // 检查文件是否存在
        if (!overwrite) {
          const filePath = join(downloadPath, `${fileName}.${fileType}`);
          try {
            await access(filePath);
            return { status: "skipped", message: t("message.file_exists") };
          } catch {
            // 文件不存在，继续下载
          }
        }
        // 下载文件
        const songDownload = await download(win, url, {
          directory: downloadPath,
          filename: `${fileName}.${fileType}`,
          showProgressBar: false,
          onProgress: (progress) => {
            win.webContents.send("download-progress", {
              ...progress,
              id: songData?.id,
              platform: songData?.platform,
            });
          },
        });
        if (!downloadMeta || !songData?.cover) return { status: "success" };
        // 下载封面
        const coverUrl = songData?.coverSize?.l || songData.cover;
        const coverDownload = await download(win, coverUrl, {
          directory: downloadPath,
          filename: `${fileName}.jpg`,
          showProgressBar: false,
        });
        // 读取歌曲文件
        let songFile = File.createFromPath(songDownload.getSavePath());
        // 清除原有标签，防止脏数据（如模拟播放下载时的乱码歌词）
        songFile.removeTags(TagTypes.AllTags);
        songFile.save();
        songFile.dispose();
        // 重新读取文件以写入新标签
        // 读取歌曲文件
        songFile = File.createFromPath(songDownload.getSavePath());
        // 生成图片信息
        const songCover = Picture.fromPath(coverDownload.getSavePath());
        // 保存修改后的元数据
        // Id3v2Settings.forceDefaultVersion = true;
        // Id3v2Settings.defaultVersion = 3;
        songFile.tag.title = songData?.name || "未知曲目";
        songFile.tag.album = songData?.album?.name || "未知专辑";
        songFile.tag.performers = songData?.artists?.map((ar: any) => ar.name) || ["未知艺术家"];
        songFile.tag.albumArtists = songData?.artists?.map((ar: any) => ar.name) || ["未知艺术家"];
        if (lyric && downloadLyric) songFile.tag.lyrics = lyric;
        if (songCover && downloadCover) songFile.tag.pictures = [songCover];
        // 保存元信息
        songFile.save();
        songFile.dispose();
        // 创建同名歌词文件
        if (lyric && saveMetaFile && downloadLyric) {
          const lrcPath = join(downloadPath, `${fileName}.lrc`);
          await writeFile(lrcPath, lyric, "utf-8");
        }
        // 是否删除封面
        if (!saveMetaFile || !downloadCover) await unlink(coverDownload.getSavePath());
        return { status: "success" };
      } catch (error) {
        ipcLog.error("❌ Error downloading file:", error);
        return {
          status: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // 检查是否是子文件夹
  ipcMain.handle("check-if-subfolder", (_, localFilesPath: string[], selectedDir: string) => {
    const resolvedSelectedDir = resolve(selectedDir);
    const allPaths = localFilesPath.map((p) => resolve(p));
    return allPaths.some((existingPath) => {
      const relativePath = relative(existingPath, resolvedSelectedDir);
      return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath);
    });
  });
};

export default initFileIpc;
