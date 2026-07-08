import { type PlayModeType } from "@/types/main";
import { cloneDeep } from "lodash-es";
import { useMusicStore, useStatusStore, useDataStore, useSettingStore } from "@/stores";
import { calculateProgress, msToS } from "./time";
import { shuffleArray } from "./helper";
import songManager from "./songManager";
import { isElectron } from "./env";
import lyricManager from "./lyricManager";
import audioManager, { AudioEventType } from "./audioManager";
import blob from "./blob";
import { listRadioSongs } from "@/api/radio";
import { t } from "@/i18n";
import type { Link, SongInfo } from "@/types/main.hemusic";
import { AxiosError } from "axios";

/**
 * 播放器核心
 * 基于 AudioManager 实现
 */
class Player {
  /** 自动关闭定时器 */
  private autoCloseInterval: ReturnType<typeof setInterval> | undefined;
  private lastErrorTime = 0;
  /** 当前曲目重试信息（按歌曲维度计数） */
  private retryInfo: { songId: string; count: number; total: number } = {
    songId: "",
    count: 0,
    total: 0,
  };
  /** 存储事件回调函数的引用，用于清理 */
  private eventCallbacks: Map<AudioEventType, (e: Event) => void> = new Map();

  constructor() {
    // 初始化媒体会话
    this.initMediaSession();
    // 绑定音频事件
    this.bindAudioEvents();
  }
  /**
   * 解绑 AudioManager 事件
   */
  private unbindAudioEvents() {
    // 清理所有音频事件监听器
    this.eventCallbacks.forEach((callback, event) => {
      audioManager.off(event, callback);
    });
    this.eventCallbacks.clear();
  }
  /**
   * 绑定 AudioManager 事件
   */
  private bindAudioEvents() {
    // 清理可能存在的旧事件监听器
    this.unbindAudioEvents();
    // 播放
    // 播放
    const playCallback = () => {
      const statusStore = useStatusStore();
      const playSongData = songManager.getPlaySongData();
      const { name, artist } = songManager.getPlayerInfoObj() || {};
      const playTitle = `${name} - ${artist}`;
      window.document.title = `${playTitle} | HE-Music`;
      statusStore.playStatus = true;
      // IPC 通知
      if (isElectron) {
        window.electron.ipcRenderer.send("play-status-change", true);
        window.electron.ipcRenderer.send("play-song-change", playTitle);
        window.electron.ipcRenderer.send("update-desktop-lyric-data", {
          playName: name,
          artistName: artist,
        });
      }
      console.log("▶️ song play:", playSongData);
    };
    audioManager.on("play", playCallback);
    this.eventCallbacks.set("play", playCallback);

    const canPlayCallback = () => {
      const playSongData = songManager.getPlaySongData();
      this.retryInfo = {
        songId: `${playSongData?.id}-${playSongData?.platform}`,
        count: 0,
        total: 0,
      };

      console.log("▶️ song canplay:", playSongData);
    };
    audioManager.on("canplay", canPlayCallback);
    this.eventCallbacks.set("canplay", canPlayCallback);
    // 暂停
    const pauseCallback = () => {
      const statusStore = useStatusStore();
      const playSongData = songManager.getPlaySongData();
      statusStore.playStatus = false;
      if (!isElectron) window.document.title = "HE-Music";
      // IPC 通知
      if (isElectron) {
        window.electron.ipcRenderer.send("play-status-change", false);
      }
      console.log("⏸️ song pause:", playSongData);
    };
    audioManager.on("pause", pauseCallback);
    this.eventCallbacks.set("pause", pauseCallback);
    // 结束
    const endedCallback = () => {
      const statusStore = useStatusStore();
      const playSongData = songManager.getPlaySongData();
      console.log("⏹️ song end:", playSongData);
      // 检查自动关闭
      if (
        statusStore.autoClose.enable &&
        statusStore.autoClose.waitSongEnd &&
        statusStore.autoClose.remainTime <= 0
      ) {
        this.executeAutoClose();
        return;
      }
      this.nextOrPrev("next", true, true);
    };
    audioManager.on("ended", endedCallback);
    this.eventCallbacks.set("ended", endedCallback);
    // 错误
    const errorCallback = (e: Event) => {
      const playSongData = songManager.getPlaySongData();
      console.error("❌ song error:", playSongData, e);
      const customEvent = e as CustomEvent<{
        originalEvent: Event;
        errorCode: number;
      }>;
      this.handlePlaybackError(customEvent.detail.errorCode);
    };
    audioManager.on("error", errorCallback);
    this.eventCallbacks.set("error", errorCallback);
    // 进度更新
    const timeupdateCallback = () => {
      const musicStore = useMusicStore();
      const statusStore = useStatusStore();
      const settingStore = useSettingStore();
      // 计算进度条距离
      const currentTime = Math.floor(audioManager.currentTime * 1000);
      const duration = Math.floor(audioManager.duration * 1000) || statusStore.duration;
      // 计算进度条
      const progress = calculateProgress(currentTime, duration);
      // 计算歌词索引
      const lyricIndex = lyricManager.calculateLyricIndex(currentTime);
      // 更新状态
      statusStore.$patch({ currentTime, duration, progress, lyricIndex });
      // 更新 MediaSession
      this.updateMediaSessionState(duration, currentTime);
      // 客户端事件
      if (isElectron) {
        // 歌词变化
        window.electron.ipcRenderer.send(
          "play-lyric-change",
          cloneDeep({
            lyricIndex,
            currentTime,
            songId: musicStore.playSong?.id,
            songOffset: statusStore.getSongOffset(musicStore.playSong),
          }),
        );
        // 进度条
        if (settingStore.showTaskbarProgress) {
          window.electron.ipcRenderer.send("set-bar", progress);
        }
      }
    };
    audioManager.on("timeupdate", timeupdateCallback);
    this.eventCallbacks.set("timeupdate", timeupdateCallback);
    // 加载开始
    const loadstartCallback = () => {
      const statusStore = useStatusStore();
      statusStore.playLoading = true;
    };
    audioManager.on("loadstart", loadstartCallback);
    this.eventCallbacks.set("loadstart", loadstartCallback);
    // 可以播放
    const canplayCallback = () => {
      const statusStore = useStatusStore();
      statusStore.playLoading = false;
      // 恢复均衡器
      if (isElectron && statusStore.eqEnabled) {
        // 简单恢复 EQ 增益
        const bands = statusStore.eqBands;
        if (bands && bands.length === 10) {
          bands.forEach((val, idx) => audioManager.setFilterGain(idx, val));
        }
      }
      // IPC 通知
      if (isElectron) {
        const dataStore = useDataStore();
        const playSongData = songManager.getPlaySongData();
        window.electron.ipcRenderer.send("play-song-change", songManager.getPlayerInfo());
        window.electron.ipcRenderer.send(
          "like-status-change",
          dataStore.isLikeSong(playSongData || { id: "", platform: "" }),
        );
      }
    };
    audioManager.on("canplay", canplayCallback);
    this.eventCallbacks.set("canplay", canplayCallback);
  }
  /**
   * 创建播放器并播放
   * @param src 播放地址
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   */
  private async createPlayer(src: string, autoPlay: boolean = true, seek: number = 0) {
    // 获取数据
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 播放信息
    const { id, platform, path } = musicStore.playSong;
    // 设置音量和速率
    audioManager.setVolume(statusStore.playVolume);
    audioManager.setRate(statusStore.playRate);
    // 播放设备
    if (!settingStore.showSpectrums) this.toggleOutputDevice();
    // 加载并播放
    try {
      await audioManager.play(src, { fadeIn: false, autoPlay });
      // 恢复进度
      if (seek && seek > 0) {
        audioManager.seek(seek / 1000);
      }
    } catch (e) {
      console.error("Player create failed", e);
      throw e;
    }
    // 获取歌词数据
    lyricManager.handleLyric(id, platform, path);
    // 新增播放历史
    dataStore.setHistory(musicStore.playSong);
    // 获取歌曲封面主色
    if (!path) songManager.getCoverColor(musicStore.songCover);
    // 更新 MediaSession
    if (!path) this.updateMediaSession();
  }
  /**
   * 初始化 MediaSession
   */
  private initMediaSession() {
    const settingStore = useSettingStore();
    if (!settingStore.smtcOpen) return;
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => this.play());
    navigator.mediaSession.setActionHandler("pause", () => this.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => this.nextOrPrev("prev"));
    navigator.mediaSession.setActionHandler("nexttrack", () => this.nextOrPrev("next"));
    navigator.mediaSession.setActionHandler("seekto", (event) => {
      const seekTime = event.seekTime ? Number(event.seekTime) * 1000 : 0;
      if (seekTime) this.setSeek(seekTime);
    });
  }
  /** 更新 MediaSession */
  private updateMediaSession() {
    const settingStore = useSettingStore();
    if (!settingStore.smtcOpen) return;
    if (!("mediaSession" in navigator)) return;
    const musicStore = useMusicStore();
    // 获取播放数据
    const playSongData = songManager.getPlaySongData();
    if (!playSongData) return;
    // 获取数据
    const metaData: MediaMetadataInit = {
      title: playSongData.name,
      artist: Array.isArray(playSongData.artists)
        ? playSongData.artists.map((item) => item.name).join(" / ")
        : String(playSongData.artists),
      album:
        typeof playSongData.album === "object"
          ? playSongData.album.name
          : String(playSongData.album),
      artwork: [
        {
          src: musicStore.getSongCover(1000),
          sizes: "1000x1000",
          type: "image/jpeg",
        },
        {
          src: musicStore.getSongCover(700),
          sizes: "700x700",
          type: "image/jpeg",
        },
        {
          src: musicStore.getSongCover(500),
          sizes: "500x500",
          type: "image/jpeg",
        },
      ],
    };
    navigator.mediaSession.metadata = new window.MediaMetadata(metaData);
  }
  /**
   * 实时更新 MediaSession
   * @param duration 歌曲总时长（毫秒）
   * @param currentTime 当前播放时间（毫秒）
   */
  private updateMediaSessionState(duration: number, currentTime: number) {
    const settingStore = useSettingStore();
    if (!settingStore.smtcOpen) return;
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setPositionState({
      duration: msToS(duration),
      position: msToS(currentTime),
    });
  }
  /**
   * 获取频谱数据
   */
  getSpectrumData(): Uint8Array | null {
    return audioManager.getFrequencyData();
  }
  /**
   * 集中处理播放错误与重试策略
   */
  private async handlePlaybackError(errCode?: number) {
    // 错误防抖
    const now = Date.now().valueOf();
    if (now - this.lastErrorTime < 200) return;
    this.lastErrorTime = now;
    const dataStore = useDataStore();
    const playSongData = songManager.getPlaySongData();
    const currentSongId = `${playSongData?.id}-${playSongData?.platform}`;
    // 初始化/切换曲目时重置计数
    if (!this.retryInfo.songId || this.retryInfo.songId !== currentSongId) {
      this.retryInfo = { songId: currentSongId, count: 0, total: this.retryInfo.total };
    }
    this.retryInfo.count += 1;
    this.retryInfo.total += 1;

    console.log(this.retryInfo);
    // 错误码 2：资源过期或临时网络错误，允许较少次数的刷新
    if (errCode === 2 && this.retryInfo.count <= 2) {
      await this.initPlayer(true, this.getSeek());
      return;
    }

    if (this.retryInfo.count == 4 || this.retryInfo.total >= 15) {
      window.$message.error("播放错误次数过多，已停止播放");
      return;
    }
    if (dataStore.playList.length > 1) {
      window.$message.error("当前歌曲播放失败，已跳至下一首");
      await this.nextOrPrev("next");
    } else {
      window.$message.error(t("message.no_playable_song"));
    }
  }
  /**
   * 获取本地歌曲元信息
   * @param path 歌曲路径
   */
  private async parseLocalMusicInfo(path: string) {
    try {
      const musicStore = useMusicStore();
      // 清理旧的 blob URL（如果存在）
      const oldCover = musicStore.playSong.cover;
      const oldPath = musicStore.playSong.path;
      if (oldCover && oldCover.startsWith("blob:") && oldPath && oldPath !== path) {
        blob.revokeBlobURL(oldPath);
      }
      // 获取封面数据
      const coverData = await window.electron.ipcRenderer.invoke("get-music-cover", path);
      if (coverData) {
        const { data, format } = coverData;
        const blobURL = blob.createBlobURL(data, format, path);
        if (blobURL) musicStore.playSong.cover = blobURL;
      } else {
        musicStore.playSong.cover = "/images/song.jpg?asset";
      }
      // 更新媒体会话
      this.updateMediaSession();
      // 获取元数据
      // const infoData: { format: IFormat } = await window.electron.ipcRenderer.invoke(
      //   "get-music-metadata",
      //   path,
      // );
      // TODO 更新音质
      // statusStore.songQuality = handleSongQuality(infoData.format.bitrate ?? 0);
      // 获取主色
      songManager.getCoverColor(musicStore.playSong.cover);
    } catch (error) {
      window.$message.error(t("message.get_local_music_meta_fail"));
      console.error("Failed to parse local music info:", error);
    }
  }
  /**
   * 重置状态
   */
  public resetStatus() {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 重置状态
    statusStore.$patch({
      currentTime: 0,
      duration: 0,
      progress: 0,
      lyricIndex: -1,
      playStatus: false,
      playLoading: false,
    });
    musicStore.$patch({
      playPlaylist: {},
    });
    musicStore.resetMusicData();
    if (settingStore.showTaskbarProgress) {
      window.electron.ipcRenderer.send("set-bar", "none");
    }
  }
  /**
   * 初始化播放器
   * 核心外部调用
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   * @param quality 音质
   */
  public async initPlayer(autoPlay: boolean = true, seek: number = 0, quality: string = "") {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    try {
      // 获取播放数据
      const playSongData = songManager.getPlaySongData();
      if (!playSongData) {
        statusStore.playLoading = false;
        return;
      }
      const { id, platform, path } = playSongData;
      // 更改当前播放歌曲
      musicStore.playSong = playSongData;
      statusStore.playLoading = true;
      // 停止当前播放
      audioManager.pause();
      // 本地歌曲
      if (path) {
        try {
          await this.createPlayer(`file://${path}`, autoPlay, seek);
          await this.parseLocalMusicInfo(path);
        } catch (err) {
          console.error("播放器初始化错误（本地）：", err);
          // createPlayer 内部已触发 handlePlaybackError，这里只记录日志
          // 如果 createPlayer 没有触发错误处理，则手动触发
          const errCode = audioManager.getErrorCode();
          if (errCode === 0) {
            // 如果没有错误码，可能是其他类型的错误，触发通用错误处理
            await this.handlePlaybackError(undefined);
          }
        }
      }
      // 在线歌曲
      else if (id && platform) {
        // 播放地址
        let playerUrl: string | null = null;

        // 获取歌曲 URL 单独 try-catch
        try {
          const link = this.selectPlayQuality(playSongData, quality);
          if (!link) throw new Error("Get song link error");
          statusStore.playQuality = link.name;
          console.log("Getting online song url...", id, platform, link);
          playerUrl = await songManager.getOnlineUrl(id, platform, link);
        } catch (err) {
          console.error("❌ 获取歌曲地址出错：", err);
          console.log("Getting online song url error:", err);
          // 如果是 AxiosError 的 401 就忽略
          if (err instanceof AxiosError && err.response?.status === 401) {
            return;
          }
          window.$message.error(t("message.no_song_link"));
          await this.handlePlaybackError(undefined);
          return;
        }
        // 有有效 URL 才创建播放器
        if (playerUrl) {
          try {
            await this.createPlayer(playerUrl, autoPlay, seek);
            if (quality) {
              window.$message.success(t("message.change_quality_to", { quality }));
            }
          } catch (err) {
            console.error("播放器初始化错误（在线）：", err);
            // createPlayer 内部已触发 handlePlaybackError，这里只记录日志
            // 如果 createPlayer 没有触发错误处理，则手动触发
            const errCode = audioManager.getErrorCode();
            if (errCode === 0) {
              // 如果没有错误码，可能是其他类型的错误，触发通用错误处理
              await this.handlePlaybackError(undefined);
            }
          }
        }
      }
    } catch (err) {
      console.error("❌ 初始化音乐播放器出错：", err);
      window.$message.error(t("message.song_play_fail"));
      await this.handlePlaybackError(undefined);
    }
  }
  /**
   * 播放
   */
  async play() {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    // 检查播放器状态
    if (!audioManager.src) {
      window.$message.warning("播放器未就绪，请稍后重试");
      return;
    }
    // 已在播放
    if (!audioManager.paused) {
      statusStore.playStatus = true;
      return;
    }
    const fadeTime = settingStore.getFadeTime ? settingStore.getFadeTime / 1000 : 0;
    await audioManager.play(undefined, { fadeIn: !!fadeTime, fadeDuration: fadeTime });
  }
  /**
   * 暂停
   * @param changeStatus 是否更改播放状态
   */
  public async pause(changeStatus: boolean = true) {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    if (!audioManager.src) return;
    if (changeStatus) statusStore.playStatus = false;
    // 淡出
    const fadeTime = settingStore.getFadeTime ? settingStore.getFadeTime / 1000 : 0;
    audioManager.pause({ fadeOut: !!fadeTime, fadeDuration: fadeTime });
  }
  /**
   * 播放或暂停
   */
  public async playOrPause() {
    const statusStore = useStatusStore();
    if (statusStore.playStatus) await this.pause();
    else await this.play();
  }
  /**
   * 下一首或上一首
   * @param type 切换类别 next 下一首 prev 上一首
   * @param play 是否立即播放
   * @param autoEnd 是否为歌曲自动播放结束
   */
  public async nextOrPrev(
    type: "next" | "prev" = "next",
    play: boolean = true,
    autoEnd: boolean = false,
  ) {
    const statusStore = useStatusStore();
    const dataStore = useDataStore();
    try {
      // 立即更新UI状态，防止用户重复点击
      statusStore.playLoading = true;
      statusStore.playStatus = false;
      // 获取数据
      const { playList } = dataStore;
      const { playSongMode } = statusStore;
      // 若为私人FM
      if (statusStore.radioMode) {
        await this.nextRadio(false, true);
        return;
      }
      // 列表长度
      const playListLength = playList.length;
      // 播放列表是否为空
      if (playListLength === 0) {
        window.$message.error("播放列表为空，请添加歌曲");
        return;
      }
      // 只有一首歌的特殊处理
      if (playListLength === 1) {
        statusStore.playLoading = false;
        this.setSeek(0);
        await this.play();
        return;
      }
      // 单曲循环
      if (playSongMode === "repeat-once" && autoEnd) {
        statusStore.playLoading = false;
        this.setSeek(0);
        await this.play();
        return;
      }
      // 列表循环、单曲循环（手动切歌）、处于心动模式或随机模式
      if (
        playSongMode === "repeat" ||
        playSongMode === "repeat-once" ||
        playSongMode === "shuffle"
      ) {
        statusStore.playIndex += type === "next" ? 1 : -1;
      } else {
        throw new Error("The play mode is not supported");
      }
      // 索引是否越界
      if (statusStore.playIndex < 0) {
        statusStore.playIndex = playListLength - 1;
      } else if (statusStore.playIndex >= playListLength) {
        statusStore.playIndex = 0;
      }
      // 重置播放进度
      statusStore.currentTime = 0;
      statusStore.progress = 0;
      // 初始化播放器（不传入seek参数，确保从头开始播放）
      await this.initPlayer(play, 0);
    } catch (error) {
      console.error("Error in nextOrPrev:", error);
      statusStore.playLoading = false;
      throw error;
    }
  }
  /**
   * 切换播放模式
   */
  public async togglePlayMode(mode: PlayModeType | false) {
    const statusStore = useStatusStore();
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    // 计算目标模式
    let targetMode: PlayModeType;
    if (mode) {
      targetMode = mode;
    } else {
      switch (statusStore.playSongMode) {
        case "repeat":
          targetMode = "repeat-once";
          break;
        case "shuffle":
          targetMode = "repeat";
          break;
        case "repeat-once":
          targetMode = "shuffle";
          break;
        default:
          targetMode = "repeat";
      }
    }
    // 进入随机模式：保存原顺序并打乱当前歌单
    if (targetMode === "shuffle" && statusStore.playSongMode !== "shuffle") {
      const currentList = dataStore.playList;
      if (currentList && currentList.length > 1) {
        const currentSongId = musicStore.playSong?.id;
        const currentPlatform = musicStore.playSong?.platform;
        await dataStore.setOriginalPlayList(currentList);
        const shuffled = shuffleArray(currentList);
        await dataStore.setPlayList(shuffled);
        if (currentSongId) {
          const newIndex = shuffled.findIndex(
            (s) => s?.id === currentSongId && s?.platform === currentPlatform,
          );
          if (newIndex !== -1) useStatusStore().playIndex = newIndex;
        }
      }
    }
    // 离开随机模式：恢复到原顺序
    if (
      statusStore.playSongMode === "shuffle" &&
      (targetMode === "repeat" || targetMode === "repeat-once")
    ) {
      const original = await dataStore.getOriginalPlayList();
      if (original && original.length) {
        const currentSongId = musicStore.playSong?.id;
        const currentPlatform = musicStore.playSong?.platform;
        await dataStore.setPlayList(original);
        if (currentSongId) {
          const origIndex = original.findIndex(
            (s) => s?.id === currentSongId && s?.platform === currentPlatform,
          );
          useStatusStore().playIndex = origIndex !== -1 ? origIndex : 0;
        } else {
          useStatusStore().playIndex = 0;
        }
        await dataStore.clearOriginalPlayList();
      }
    }
    // 应用模式
    statusStore.playSongMode = targetMode;
    this.playModeSyncIpc();
  }
  /**
   * 播放模式同步 ipc
   */
  public playModeSyncIpc() {
    const statusStore = useStatusStore();
    if (isElectron) {
      window.electron.ipcRenderer.send("play-mode-change", statusStore.playSongMode);
    }
  }
  /**
   * 设置播放进度
   * @param time 播放进度（单位：毫秒）
   */
  public setSeek(time: number) {
    const statusStore = useStatusStore();
    if (time < 0 || time > this.getDuration()) {
      time = Math.max(0, Math.min(time, this.getDuration()));
    }
    audioManager.seek(time / 1000);
    statusStore.currentTime = time;
  }
  /**
   * 获取播放进度
   * @returns 播放进度（单位：毫秒）
   */
  public getSeek(): number {
    return Math.floor(audioManager.currentTime * 1000);
  }
  /**
   * 获取播放时长
   * @returns 播放时长（单位：毫秒）
   */
  public getDuration(): number {
    return Math.floor(audioManager.duration * 1000);
  }
  /**
   * 设置播放速率
   */
  public setRate(rate: number) {
    const statusStore = useStatusStore();
    audioManager.setRate(rate);
    statusStore.playRate = rate;
  }

  /**
   * 设置播放音量
   */
  public setVolume(actions: number | "up" | "down" | WheelEvent) {
    const statusStore = useStatusStore();
    const increment = 0.05;

    if (typeof actions === "number") {
      actions = Math.max(0, Math.min(actions, 1));
      statusStore.playVolume = actions;
    } else if (actions === "up" || actions === "down") {
      statusStore.playVolume = Math.max(
        0,
        Math.min(statusStore.playVolume + (actions === "up" ? increment : -increment), 1),
      );
    } else {
      const deltaY = actions.deltaY;
      const volumeChange = deltaY > 0 ? -increment : increment;
      statusStore.playVolume = Math.max(0, Math.min(statusStore.playVolume + volumeChange, 1));
    }

    audioManager.setVolume(statusStore.playVolume);
  }

  /**
   * 切换静音
   */
  public toggleMute() {
    const statusStore = useStatusStore();
    const isMuted = statusStore.playVolume === 0;

    if (isMuted) {
      statusStore.playVolume = statusStore.playVolumeMute;
    } else {
      statusStore.playVolumeMute = audioManager.getVolume();
      statusStore.playVolume = 0;
    }
    audioManager.setVolume(statusStore.playVolume);
  }

  /**
   * 更新播放列表
   * @param data 播放列表
   * @param song 当前播放歌曲
   * @param playlist
   * @param options 配置
   * @param options.showTip 是否显示提示
   * @param options.scrobble 是否打卡
   * @param options.play 是否直接播放
   */
  public async updatePlayList(
    data: SongInfo[],
    song?: SongInfo,
    playlist: {
      id?: string;
      platform?: string;
      type?: string;
    } = {
      id: "",
      platform: "",
      type: "",
    },
    options: {
      showTip?: boolean;
      scrobble?: boolean;
      play?: boolean;
    } = {
      showTip: true,
      scrobble: true,
      play: true,
    },
  ) {
    if (!data || !data.length) return;
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 获取配置
    const { showTip, play } = options;
    // 处理随机播放模式
    let processedData = cloneDeep(data);
    if (statusStore.playSongMode === "shuffle") {
      // 保存原始播放列表
      await dataStore.setOriginalPlayList(cloneDeep(data));
      // 随机排序
      processedData = shuffleArray(processedData);
    }
    // 更新列表
    await dataStore.setPlayList(processedData);
    // 关闭特殊模式
    if (statusStore.radioMode) statusStore.radioMode = false;
    // 是否直接播放
    if (song && typeof song === "object" && "id" in song) {
      // 是否为当前播放歌曲
      if (musicStore.playSong.id === song.id && musicStore.playSong.platform === song.platform) {
        if (play) await this.play();
      } else {
        // 查找索引（在处理后的列表中查找）
        statusStore.playIndex = data.findIndex(
          (item) => item.id === song.id && item.platform === song.platform,
        );
        // 播放
        await this.initPlayer();
      }
    } else {
      statusStore.playIndex =
        statusStore.playSongMode === "shuffle"
          ? Math.floor(Math.random() * processedData.length)
          : 0;
      await this.initPlayer();
    }
    musicStore.playPlaylist.type = playlist.type || "";
    musicStore.playPlaylist.id = playlist.id || "";
    musicStore.playPlaylist.platform = playlist.platform || "";
    if (showTip) window.$message.success("已开始播放");
  }

  /**
   * 添加下一首歌曲
   * @param song 歌曲
   * @param play 是否立即播放
   */
  public async addNextSong(song: SongInfo, play: boolean = false) {
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 关闭特殊模式
    if (statusStore.radioMode) statusStore.radioMode = false;

    // 是否为当前播放歌曲
    if (musicStore.playSong.id === song.id && musicStore.playSong.platform === song.platform) {
      this.play();
      window.$message.success(t("message.play_started"));
      return;
    }
    // 尝试添加
    const currentSongId = musicStore.playSong.id;
    const currentPlatform = musicStore.playSong.platform;
    const songIndex = await dataStore.setNextPlaySong(song, statusStore.playIndex);
    // 播放歌曲
    if (songIndex < 0) return;
    if (play) {
      this.togglePlayIndex(songIndex, true);
    } else {
      // 修正当前播放索引
      const newCurrentIndex = dataStore.playList.findIndex(
        (s) => s.id === currentSongId && s.platform === currentPlatform,
      );
      if (newCurrentIndex !== -1 && newCurrentIndex !== statusStore.playIndex) {
        statusStore.playIndex = newCurrentIndex;
      }
      window.$message.success(t("message.added_to_next_play"));
    }
  }
  /**
   * 切换播放索引
   * @param index 播放索引
   * @param play 是否立即播放
   */
  public async togglePlayIndex(index: number, play: boolean = false) {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    try {
      // 立即更新UI状态，防止用户重复点击
      statusStore.playLoading = true;
      statusStore.playStatus = false;
      // 获取数据
      const { playList } = dataStore;
      // 若超出播放列表
      if (index >= playList.length) return;
      // 相同
      if (!play && statusStore.playIndex === index) {
        this.play();
        return;
      }
      // 更改状态
      statusStore.playIndex = index;
      // 重置播放进度（切换歌曲时必须重置）
      statusStore.currentTime = 0;
      statusStore.progress = 0;
      statusStore.lyricIndex = -1;
      await this.initPlayer(true, 0);
    } catch (error) {
      console.error("Error in togglePlayIndex:", error);
      statusStore.playLoading = false;
      throw error;
    }
  }
  /**
   * 移除指定歌曲
   * @param index 歌曲索引
   */
  public removeSongIndex(index: number) {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    // 获取数据
    const { playList } = dataStore;
    // 若超出播放列表
    if (index >= playList.length) return;
    // 仅剩一首
    if (playList.length === 1) {
      this.cleanPlayList();
      return;
    }
    // 是否为当前播放歌曲
    const isCurrentPlay = statusStore.playIndex === index;
    // 深拷贝，防止影响原数据
    const newPlaylist = cloneDeep(playList);
    // 若将移除最后一首
    if (index === playList.length - 1) {
      statusStore.playIndex = 0;
    }
    // 若为当前播放之后
    else if (statusStore.playIndex > index) {
      statusStore.playIndex--;
    }
    // 移除指定歌曲
    newPlaylist.splice(index, 1);
    dataStore.setPlayList(newPlaylist);
    // 若为当前播放
    if (isCurrentPlay) {
      this.initPlayer(statusStore.playStatus);
    }
  }
  /**
   * 清空播放列表
   */
  public async cleanPlayList() {
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    audioManager.stop();
    this.resetStatus();
    statusStore.resetPlayStatus();
    await dataStore.setPlayList([]);
    await dataStore.clearOriginalPlayList();
  }
  /**
   * 切换输出设备
   * @param deviceId 输出设备
   */
  public toggleOutputDevice(deviceId?: string) {
    try {
      const settingStore = useSettingStore();
      const device = deviceId ?? settingStore.playDevice;
      if (device) {
        audioManager.setSinkId(device);
      }
    } catch (error) {
      console.error("Failed to change audio output device:", error);
    }
  }
  /**
   * 启用/更新均衡器
   * @param options 均衡器选项
   */
  public enableEq(options?: {
    bands?: number[];
    preamp?: number;
    q?: number;
    frequencies?: number[];
  }) {
    // 暂未完全适配 preamp 和 q 的动态调整，仅处理 bands
    if (options?.bands) {
      options.bands.forEach((val, idx) => audioManager.setFilterGain(idx, val));
    }
  }
  /**
   * 更新均衡器
   * @param options 均衡器选项
   */
  public updateEq(options: { bands?: number[]; preamp?: number; q?: number }) {
    this.enableEq(options);
  }
  /**
   * 禁用均衡器并恢复直出（保持频谱可用）
   */
  public disableEq() {
    // 将所有频段增益设为 0
    for (let i = 0; i < 10; i++) {
      audioManager.setFilterGain(i, 0);
    }
  }
  /**
   * 切换桌面歌词
   */
  public toggleDesktopLyric() {
    const statusStore = useStatusStore();
    const show = !statusStore.showDesktopLyric;
    statusStore.showDesktopLyric = show;
    window.electron.ipcRenderer.send("toggle-desktop-lyric", show);
    window.$message.success(
      show ? t("message.desktop_lyrics_opened") : t("message.desktop_lyrics_closed"),
    );
  }
  /**
   * 显式设置桌面歌词显示/隐藏
   * @param show 是否显示
   */
  public setDesktopLyricShow(show: boolean) {
    const statusStore = useStatusStore();
    if (statusStore.showDesktopLyric === show) return;
    statusStore.showDesktopLyric = show;
    window.electron.ipcRenderer.send("toggle-desktop-lyric", show);
    window.$message.success(
      show ? t("message.desktop_lyrics_opened") : t("message.desktop_lyrics_closed"),
    );
  }

  // 切换音质
  async changeQuality(quality: string) {
    const statusStore = useStatusStore();
    statusStore.selectedQuality = quality;
    if (statusStore.playQuality === quality) return;
    statusStore.playQuality = quality;
    await this.initPlayer(true, statusStore.currentTime, quality);
  }

  selectPlayQuality(songInfo: SongInfo, quality: string): Link | null {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    const currentQuality = statusStore.playQuality;
    const songLevel = settingStore.songLevel;
    const selectedQuality = statusStore.selectedQuality;

    if (songInfo.links?.length == 0) {
      return null;
    }

    // 如果有quality 说明是切换音质
    let link = songInfo.links.find((item) => item.name === quality);
    if (link) {
      return link;
    }

    const qualityList = (
      songLevel === "auto" ? [selectedQuality, "hires", "flac", "320mp3", "128mp3"] : []
    ).concat([songLevel, currentQuality, selectedQuality]);
    for (const quality of qualityList) {
      link = songInfo.links.find((item) => item.name === quality);
      if (link) {
        return link;
      }
    }
    // 默认返回第一个
    return songInfo.links[0];
  }

  /**
   * 初始化私人FM
   * @param init 是否初始化
   * @param playNext 是否播放下一首
   */
  async nextRadio(init: boolean = true, playNext: boolean = false) {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    try {
      // 获取并重置
      const getPersonalFmData = async () => {
        const result = await listRadioSongs(
          musicStore.radio.id,
          musicStore.radio.platform,
          musicStore.radio.pageIndex || 1,
        );
        console.log(`🌐 radio :`, result.list);
        musicStore.radio.playIndex = 0;
        musicStore.radio.list = result.list;
        musicStore.radio.pageIndex = result.page_index || musicStore.radio.pageIndex;
      };
      // 若为空
      if (init || musicStore.radio.list.length === 0) {
        musicStore.radio.pageIndex = 1;
        statusStore.radioMode = true;
        await getPersonalFmData();
        // 清理并播放
        this.resetStatus();
        await this.initPlayer();
        return;
      }
      // 若需播放下一首
      if (playNext) {
        // 更改索引
        if (musicStore.radio.playIndex < musicStore.radio.list.length - 1) {
          musicStore.radio.playIndex++;
        } else {
          musicStore.radio.pageIndex++;
          await getPersonalFmData();
        }
        // 清理并播放
        this.resetStatus();
        await this.initPlayer();
      }
    } catch (error) {
      console.error("Failed to initialize radio:", error);
    }
  }
  /**
   * 开始定时关闭
   */
  public startAutoCloseTimer(time: number, remainTime: number) {
    const statusStore = useStatusStore();
    if (!time || !remainTime) return;
    if (this.autoCloseInterval) {
      clearInterval(this.autoCloseInterval);
      this.autoCloseInterval = undefined;
    }
    Object.assign(statusStore.autoClose, {
      enable: true,
      time,
      remainTime,
    });
    this.autoCloseInterval = setInterval(() => {
      if (statusStore.autoClose.remainTime <= 0) {
        clearInterval(this.autoCloseInterval);
        this.autoCloseInterval = undefined;
        if (!statusStore.autoClose.waitSongEnd) {
          this.executeAutoClose();
        }
        return;
      }
      statusStore.autoClose.remainTime--;
    }, 1000);
  }
  /**
   * 执行自动关闭
   */
  private executeAutoClose() {
    console.log("🔄 执行自动关闭");
    this.pause();
    const { autoClose } = useStatusStore();
    autoClose.enable = false;
    autoClose.remainTime = autoClose.time * 60;
  }
}

let _player: Player | null = null;

/**
 * 获取播放器实例
 * @returns Player
 */
export const usePlayer = (): Player => {
  if (!_player) _player = new Player();
  return _player;
};
