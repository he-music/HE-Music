import { type PlayModeType } from "@/types/main";
import { cloneDeep } from "lodash-es";
import { useMusicStore, useStatusStore, useDataStore, useSettingStore } from "@/stores";
import { calculateProgress } from "./time";
import { shuffleArray } from "./helper";
import songManager from "./songManager";
import { isMygo } from "./env";
import { desktopLyricsSession } from "@/platform/desktopLyricsSession";
import { localResourceURL } from "@/platform/localResource";
import {
  localAudioBlocked,
  registerLocalAudioStopper,
  type LocalAudioBlockTarget,
} from "@/platform/localAudioSession";
import { nativeLocalEntry } from "@/platform/localFilesSession";
import lyricManager from "./lyricManager";
import audioManager, { AudioEventType } from "./audioManager";
import type { AudioSourceInfo } from "./audioCapability";
import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";
import { filesSession } from "@/platform/filesSession";
import { selectPlaybackQuality } from "./playbackQuality";
import { listRadioSongs } from "@/api/radio";
import { t } from "@/i18n";
import type { Link, SongInfo } from "@/types/main.hemusic";
import { AxiosError } from "axios";
import { createNativePlayModeCoordinator } from "./nativePlayMode";

import { PlaybackRecovery } from "./playbackRecovery";
import { BrowserMediaSession } from "./browserMediaSession";
import { resolveDownloadedPlayback, type DownloadedPlayback } from "@/platform/downloadedPlayback";

import { gatewayProxyUrl } from "@/platform/gateway";

class PlaybackOutputError extends Error {}
/**
 * 播放器核心
 * 基于 AudioManager 实现
 */
class Player {
  private readonly mediaSession = new BrowserMediaSession();
  private downloadedPlayback?: DownloadedPlayback;
  private readonly failedDownloads = new Set<string>();
  /** 自动关闭定时器 */
  private autoCloseInterval: ReturnType<typeof setInterval> | undefined;
  /** 存储事件回调函数的引用，用于清理 */
  private eventCallbacks: Map<AudioEventType, (e: Event) => void> = new Map();
  private seekListeners = new Set<() => void>();

  public onSeek(listener: () => void): () => void {
    this.seekListeners.add(listener);
    return () => {
      this.seekListeners.delete(listener);
    };
  }

  private notifySeek(): void {
    this.seekListeners.forEach((listener) => listener());
  }
  /** 播放请求递增序号，用于防止快速切歌异步竞态 */
  private playRequestId = 0;
  /** radio API 等待期尚无新 source request，须单独标识这次操作。 */
  private radioOperation?: symbol;
  // Playback intent is separate from source ownership: pause must not discard
  // the pending preload or its metadata, but it must revoke future autoplay.
  private autoPlayIntent = true;
  private autoPlayOwner?: () => boolean;
  private pendingAutoPlay?: { owner: () => boolean; requestId: number; src?: string };
  private recovery = new PlaybackRecovery({
    audio: audioManager,
    isMygo: () => isMygo,
    getRequestId: () => this.playRequestId,
    hasRadioOperation: () => !!this.radioOperation,
    clearRadioOperation: () => {
      this.radioOperation = undefined;
    },
    getAutoPlayIntent: () => this.autoPlayIntent,
    getAutoPlayOwner: () => this.autoPlayOwner,
    revokeAutoPlay: () => {
      this.autoPlayIntent = false;
    },
    getStatus: () => useStatusStore(),
    getSong: () => songManager.getPlaySongData(),
    getPlaylistLength: () => useDataStore().playList.length,
    getSeek: () => this.getSeek(),
    getSongLogInfo: () => this.getSongLogInfo(),
    logError: (message, error) => this.logPlaybackError(message, error),
    selectMpv: () => {
      useSettingStore().playbackEngine = "mpv";
    },
    initPlayer: (...args) => this.initPlayer(...args),
    createPlayer: (...args) => this.createPlayer(...args),
    next: (...args) => this.nextOrPrev("next", ...args),
  });

  private nativeModes?: ReturnType<typeof createNativePlayModeCoordinator>;

  constructor() {
    registerLocalAudioStopper((target?: LocalAudioBlockTarget) => {
      const song = useMusicStore().playSong;
      if (!song.path && !this.downloadedPlayback) return;
      const entry =
        this.downloadedPlayback?.entry ?? (song.path ? nativeLocalEntry(song.id) : undefined);
      if (
        target &&
        (typeof target === "string"
          ? entry?.ref.grantToken !== target
          : !entry ||
            entry.ref.grantToken !== target.grantToken ||
            entry.ref.relativePath !== target.relativePath ||
            entry.ref.fileId !== target.fileId)
      )
        return;
      ++this.playRequestId;
      this.downloadedPlayback = undefined;
      this.recovery.closeMpvDialog();
      this.recovery.clearAttempt();
      this.pendingAutoPlay = undefined;
      const released = audioManager.clearSource();
      const status = useStatusStore();
      status.playStatus = false;
      status.playLoading = false;
      return released;
    });
    // 初始化媒体会话
    this.mediaSession.init(this);
    // 绑定音频事件
    this.bindAudioEvents();
  }
  /** 使用明确的歌曲字段，避免日志只留下标题或展开整个歌曲对象。 */
  private getSongLogInfo(): string {
    const song = songManager.getPlaySongData();
    if (!song) return "未知歌曲";
    const { name, artist } = songManager.getPlayerInfoObj(song) || {};
    return `${name} - ${artist} (platform=${song.platform}, id=${song.id})`;
  }

  private logPlaybackError(message: string, error: unknown) {
    const reason =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : typeof error === "string"
          ? error
          : "未知错误";
    // mygo 文件日志只保存首个参数；原始异常留在控制台，便于展开堆栈。
    console.error(`${message} ${this.getSongLogInfo()}; ${reason}`, error);
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
      const { name, artist } = songManager.getPlayerInfoObj() || {};
      const playTitle = `${name} - ${artist}`;
      window.document.title = `${playTitle} | HE-Music`;
      statusStore.playStatus = true;
      statusStore.playLoading = true;
      console.log(`▶️ song play: ${this.getSongLogInfo()}`);
    };
    audioManager.on("play", playCallback);
    this.eventCallbacks.set("play", playCallback);
    const playingCallback = () => {
      if (audioManager.paused) return;
      const statusStore = useStatusStore();
      statusStore.playStatus = true;
      statusStore.playLoading = false;
    };
    audioManager.on("playing", playingCallback);
    this.eventCallbacks.set("playing", playingCallback);
    const bufferingCallback = (event: Event) => {
      if (audioManager.paused) return;
      // A stalled network request can coexist with enough buffered audio.
      if (event.type === "stalled" && audioManager.readyState >= 3) return;
      useStatusStore().playLoading = true;
    };
    for (const event of ["waiting", "stalled"] as const) {
      audioManager.on(event, bufferingCallback);
      this.eventCallbacks.set(event, bufferingCallback);
    }
    // 暂停
    const pauseCallback = () => {
      const statusStore = useStatusStore();
      statusStore.playStatus = false;
      statusStore.playLoading = false;
      window.document.title = "HE-Music";
      console.log(`⏸️ song pause: ${this.getSongLogInfo()}`);
    };
    audioManager.on("pause", pauseCallback);
    this.eventCallbacks.set("pause", pauseCallback);
    // 结束
    const endedCallback = () => {
      const statusStore = useStatusStore();
      console.log(`⏹️ song end: ${this.getSongLogInfo()}`);
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
      const customEvent = e as CustomEvent<{
        originalEvent: Event;
        errorCode: number;
        errorMessage?: string;
      }>;
      const { errorCode, errorMessage } = customEvent.detail;
      const reasons: Record<number, string> = {
        1: "加载被中止",
        2: "网络错误或音源过期",
        3: "音频解码失败",
        4: "音源不可用或格式不受支持",
      };
      this.logPlaybackError(
        "❌ song error:",
        `code=${errorCode}; ${reasons[errorCode] || "未知媒体错误"}${errorMessage ? `; ${errorMessage}` : ""}`,
      );
      if (this.retryDownloadedOnline()) return;
      this.recovery.handleMediaError(errorCode, errorMessage);
    };
    audioManager.on("error", errorCallback);
    this.eventCallbacks.set("error", errorCallback);
    // 进度更新
    const timeupdateCallback = () => {
      const statusStore = useStatusStore();
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
      this.mediaSession.updatePosition(duration, currentTime);
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
      if (audioManager.paused) statusStore.playLoading = false;
      const playSongData = songManager.getPlaySongData();
      this.recovery.onCanPlay(`${playSongData?.id}-${playSongData?.platform}`);
      console.log(`▶️ song canplay: ${this.getSongLogInfo()}`);
      // 恢复均衡器
      if (statusStore.eqEnabled) {
        // 简单恢复 EQ 增益
        const bands = statusStore.eqBands;
        if (bands && bands.length === 10) {
          bands.forEach((val, idx) => audioManager.setFilterGain(idx, val));
        }
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
  private async createPlayer(
    src: string,
    autoPlay: boolean = true,
    seek: number = 0,
    canAutoPlay = this.autoPlayOwner,
    source?: AudioSourceInfo,
  ) {
    // 获取数据
    const dataStore = useDataStore();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // 播放信息
    const { id, platform, path } = musicStore.playSong;
    // 设置音量和速率
    const requestId = this.playRequestId;
    await this.toggleOutputDevice();
    await audioManager.setVolume(statusStore.playVolume);
    await audioManager.setRate(statusStore.playRate);
    if (requestId !== this.playRequestId) return;
    this.recovery.recordAttempt({ src, autoPlay, seek, requestId, canAutoPlay, source });
    const pending = this.pendingAutoPlay;
    if (pending && pending.owner === canAutoPlay && pending.requestId === requestId) {
      pending.src = audioManager.engineId === "mpv" ? (source?.identity ?? src) : src;
    }
    const allowsAutoPlay = () =>
      autoPlay &&
      this.autoPlayIntent &&
      requestId === this.playRequestId &&
      (!this.autoPlayOwner || this.autoPlayOwner());
    // 加载并播放
    try {
      // AudioManager reads autoPlay after its asynchronous source probe/load.
      // A getter keeps explicit pause and owner revocation effective during it.
      await audioManager.play(src, {
        fadeIn: false,
        ...(seek > 0 ? { seek: seek / 1000 } : {}),
        ...(source ? { source } : {}),
        get autoPlay() {
          return allowsAutoPlay();
        },
      });
      if (requestId !== this.playRequestId) return;
      // 恢复进度
      if (seek && seek > 0) {
        await audioManager.seek(seek / 1000);
        this.notifySeek();
      }
    } catch (error) {
      if (requestId !== this.playRequestId) return;
      if (!this.recovery.handlePlayRejection(error)) {
        this.logPlaybackError("Player create failed:", error);
        throw error;
      }
      if (seek > 0) {
        audioManager.seek(seek / 1000);
        this.notifySeek();
      }
    }
    // 获取歌词数据
    if (this.downloadedPlayback) {
      lyricManager.handleLyric(id, platform, undefined, this.downloadedPlayback.entry);
    } else {
      lyricManager.handleLyric(id, platform, path);
    }
    // 新增播放历史
    dataStore.setHistory(musicStore.playSong);
    // 获取歌曲封面主色
    if (!path) songManager.getCoverColor(musicStore.songCover);
    // 更新 MediaSession
    if (!path) this.mediaSession.updateMetadata();
  }
  /**
   * 获取频谱数据
   */
  getSpectrumData(): Uint8Array | null {
    return audioManager.getFrequencyData();
  }
  /**
   * 重置状态
   */
  public resetStatus(isCurrent?: () => boolean) {
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    // radio 的同步订阅也可能发起后继操作，每次提交前再次核对。
    if (isCurrent && !isCurrent()) return;
    statusStore.$patch({
      currentTime: 0,
      duration: 0,
      progress: 0,
      lyricIndex: -1,
      playStatus: false,
      playLoading: false,
    });
    if (isCurrent && !isCurrent()) return;
    musicStore.$patch({
      playPlaylist: {},
    });
    if (isCurrent && !isCurrent()) return;
    musicStore.resetMusicData();
    if (isCurrent && !isCurrent()) return;
  }
  /** 本地副本读取或解码失败时只回退一次，保留歌曲身份、位置及最新播放意图。 */
  private retryDownloadedOnline(): boolean {
    const downloaded = this.downloadedPlayback;
    if (!downloaded || ["device", "engine"].includes(audioManager.error?.kind ?? "")) return false;
    this.downloadedPlayback = undefined;
    this.failedDownloads.add(downloaded.key);
    if (this.failedDownloads.size > 32) {
      const oldest = this.failedDownloads.values().next().value;
      if (oldest) this.failedDownloads.delete(oldest);
    }
    const seek = this.getSeek();
    void this.initPlayer(
      this.autoPlayIntent,
      seek,
      useStatusStore().playQuality,
      this.autoPlayOwner,
      true,
    ).catch((error: unknown) => {
      this.logPlaybackError("已下载文件回退在线失败:", error);
      window.$message.error(t("message.song_play_fail"));
    });
    return true;
  }
  /**
   * 初始化播放器
   * 核心外部调用
   * @param autoPlay 是否自动播放
   * @param seek 播放位置
   * @param quality 音质
   * @param canAutoPlay HTTP shell owner 存活检查，独立于歌曲切换 stamp
   */
  public async initPlayer(
    autoPlay: boolean = true,
    seek: number = 0,
    quality: string = "",
    canAutoPlay?: () => boolean,
    preserveIntent = false,
  ) {
    this.radioOperation = undefined;
    if (!preserveIntent) this.autoPlayIntent = autoPlay;
    this.autoPlayOwner = canAutoPlay;
    const currentRequestId = ++this.playRequestId;
    this.pendingAutoPlay = canAutoPlay
      ? { owner: canAutoPlay, requestId: currentRequestId }
      : undefined;
    this.recovery.closeHttpDialog();
    this.recovery.closeMpvDialog();
    this.recovery.clearAttempt();
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    try {
      const engine = isMygo ? (useSettingStore().playbackEngine ?? "web-audio") : "web-audio";
      if (
        engine === "mpv" ||
        audioManager.engineId === "mpv" ||
        preserveIntent ||
        useMusicStore().playSong.path ||
        this.downloadedPlayback
      ) {
        await audioManager.clearSource();
        if (currentRequestId !== this.playRequestId) return;
      }
      this.downloadedPlayback = undefined;
      if (engine === "mpv" || (audioManager.engineId && audioManager.engineId !== engine))
        await audioManager.setEngine(engine);
      if (currentRequestId !== this.playRequestId) return;
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
        const nativeEntry = nativeLocalEntry(id);
        if (!nativeEntry?.path) {
          statusStore.playLoading = false;
          statusStore.playStatus = false;
          return;
        }
        try {
          if (localAudioBlocked()) {
            statusStore.playLoading = false;
            statusStore.playStatus = false;
            return;
          }
          const url = localResourceURL("audio", nativeEntry);
          if (!url || currentRequestId !== this.playRequestId) return;
          const source: AudioSourceInfo | undefined =
            engine === "mpv"
              ? {
                  platform: "local",
                  format: nativeEntry.path.split(".").pop()?.toLowerCase() ?? "",
                  localRef: nativeEntry.ref,
                  fileEpoch: filesSession.value?.directories.value.find(
                    (grant) => grant.token === nativeEntry.ref.grantToken,
                  )?.epoch,
                  identity: id,
                }
              : /\.flac$/i.test(nativeEntry.path)
                ? { platform: "local", format: "flac" }
                : undefined;
          await this.createPlayer(url, autoPlay, seek, this.autoPlayOwner, source);
        } catch (error) {
          if (currentRequestId !== this.playRequestId) return;
          if (engine === "mpv" || preserveIntent || error instanceof PlaybackOutputError)
            throw error;
          this.logPlaybackError("播放器初始化错误（本地）：", error);
          // createPlayer 内部已触发 handlePlaybackError，这里只记录日志
          // 如果 createPlayer 没有触发错误处理，则手动触发
          const errCode = audioManager.getErrorCode();
          if (errCode === 0) {
            // 如果没有错误码，可能是其他类型的错误，触发通用错误处理
            await this.recovery.handlePlaybackError(undefined);
          }
        }
      }
      // 在线歌曲
      else if (id && platform) {
        // 播放地址
        let playerUrl: string | null = null;
        let source: AudioSourceInfo | undefined;

        // 获取歌曲 URL 单独 try-catch
        try {
          const link = this.selectPlayQuality(playSongData, quality);
          if (isMygo && useSettingStore().preferDownloaded && !localAudioBlocked()) {
            const owner = filesSession.value;
            const downloaded = await resolveDownloadedPlayback(
              playSongData,
              link?.name || quality || statusStore.selectedQuality,
              engine,
              owner,
              () => currentRequestId === this.playRequestId && filesSession.value === owner,
              this.failedDownloads,
            );
            if (currentRequestId !== this.playRequestId) return;
            if (downloaded) {
              this.downloadedPlayback = downloaded;
              statusStore.playQuality = link?.name || quality || statusStore.selectedQuality;
              try {
                await this.createPlayer(
                  downloaded.url,
                  autoPlay,
                  seek,
                  this.autoPlayOwner,
                  downloaded.source,
                );
              } catch (error) {
                if (currentRequestId !== this.playRequestId) return;
                if (error instanceof PlaybackOutputError || !this.retryDownloadedOnline())
                  throw error;
              }
              return;
            }
          }
          if (!link) throw new Error("Get song link error");
          statusStore.playQuality = link.name;
          console.log(`Getting online song url: ${this.getSongLogInfo()}; quality=${link.name}`);
          const resolved = await songManager.getOnlineSource(id, platform, link);
          playerUrl = resolved?.url ?? null;
          if (engine === "mpv" && !playerUrl) throw new Error("Get song URL error");
          const format = resolved?.format;
          if (
            engine === "mpv" ||
            format === "flac" ||
            (platform === "migu" && format === "m4a") ||
            (isMygo && platform === "soda" && (format === "m4a" || format === "mp4"))
          ) {
            source = {
              platform,
              format: format || link.format || "",
              ...(engine === "mpv" ? { identity: `${platform}:${id}` } : {}),
            };
          }
        } catch (err) {
          if (currentRequestId !== this.playRequestId) return;
          if (engine === "mpv" || preserveIntent) throw err;
          this.logPlaybackError("❌ 获取歌曲地址出错：", err);
          // 如果是 AxiosError 的 401 就忽略
          if (err instanceof AxiosError && err.response?.status === 401) {
            return;
          }
          window.$message.error(t("message.no_song_link"));
          await this.recovery.handlePlaybackError(undefined);
          return;
        }
        if (currentRequestId !== this.playRequestId) return;
        if (playerUrl) playerUrl = gatewayProxyUrl(playerUrl);
        // 有有效 URL 才创建播放器
        if (playerUrl) {
          try {
            await this.createPlayer(playerUrl, autoPlay, seek, undefined, source);
            if (currentRequestId !== this.playRequestId) return;
            if (quality && !preserveIntent) {
              window.$message.success(t("message.change_quality_to", { quality }));
            }
          } catch (error) {
            if (currentRequestId !== this.playRequestId) return;
            if (engine === "mpv" || preserveIntent || error instanceof PlaybackOutputError)
              throw error;
            this.logPlaybackError("播放器初始化错误（在线）：", error);
            // createPlayer 内部已触发 handlePlaybackError，这里只记录日志
            // 如果 createPlayer 没有触发错误处理，则手动触发
            const errCode = audioManager.getErrorCode();
            if (errCode === 0) {
              // 如果没有错误码，可能是其他类型的错误，触发通用错误处理
              await this.recovery.handlePlaybackError(undefined);
            }
          }
        }
      }
    } catch (error) {
      if (currentRequestId !== this.playRequestId) return;
      if (
        error instanceof PlaybackOutputError ||
        preserveIntent ||
        (isMygo && useSettingStore().playbackEngine === "mpv")
      ) {
        this.autoPlayIntent = false;
        statusStore.playStatus = false;
        statusStore.playLoading = false;
        await audioManager.clearSource();
        if (preserveIntent) throw error;
        window.$message.error(
          error instanceof PlaybackOutputError ? error.message : t("message.song_play_fail"),
        );
        return;
      }
      this.logPlaybackError("❌ 初始化音乐播放器出错：", error);
      window.$message.error(t("message.song_play_fail"));
      await this.recovery.handlePlaybackError(undefined);
    }
  }
  /**
   * 播放
   */
  async play(canAutoPlay?: () => boolean) {
    if (canAutoPlay && !canAutoPlay()) return;
    const pendingRadio = this.radioOperation !== undefined;
    this.radioOperation = undefined;
    const statusStore = useStatusStore();
    if (pendingRadio) statusStore.playLoading = false;
    this.autoPlayIntent = true;
    this.autoPlayOwner = canAutoPlay;
    if (statusStore.playLoading && !audioManager.src) return;
    if (
      useMusicStore().playSong?.path &&
      (localAudioBlocked() ||
        (audioManager.src !== useMusicStore().playSong.id &&
          audioManager.src !==
            localResourceURL("audio", nativeLocalEntry(useMusicStore().playSong.id))))
    ) {
      statusStore.playStatus = false;
      return;
    }
    const settingStore = useSettingStore();
    // 检查播放器状态
    const src = audioManager.src;
    if (!src) {
      window.$message.warning("播放器未就绪，请稍后重试");
      return;
    }
    const requestId = this.playRequestId;
    this.autoPlayIntent = true;
    this.autoPlayOwner = canAutoPlay;
    // Direct HTTP resumes enter Driver.prepareOutput too: retain their owner
    // for cancellation, while an ordinary no-argument UI play takes ownership.
    this.pendingAutoPlay = canAutoPlay ? { owner: canAutoPlay, requestId, src } : undefined;
    this.recovery.updateAttemptIntent(true, canAutoPlay);
    // 已在播放
    if (!audioManager.paused) {
      statusStore.playStatus = true;
      return;
    }
    const fadeTime = settingStore.getFadeTime ? settingStore.getFadeTime / 1000 : 0;
    try {
      await audioManager.play(undefined, { fadeIn: !!fadeTime, fadeDuration: fadeTime });
    } catch (error) {
      if (requestId !== this.playRequestId) return;
      if (!this.recovery.handlePlayRejection(error)) throw error;
    }
  }
  /** Revoke one shell's pending start without pausing an already playing source. */
  public cancelPendingAutoplay(owner: () => boolean): void {
    const pending = this.pendingAutoPlay;
    if (
      !pending ||
      pending.owner !== owner ||
      this.autoPlayOwner !== owner ||
      pending.requestId !== this.playRequestId
    )
      return;
    this.autoPlayIntent = false;
    this.recovery.cancelAttemptAutoplay(pending.requestId);
    if (pending.src && pending.src === audioManager.src && audioManager.paused) {
      // No fade: cancel Driver.prepareOutput/element.play immediately, retaining the preload.
      audioManager.pause();
    }
  }
  /**
   * 暂停
   * @param changeStatus 是否更改播放状态
   */
  public async pause(changeStatus: boolean = true) {
    const statusStore = useStatusStore();
    const settingStore = useSettingStore();
    if (changeStatus) {
      this.autoPlayIntent = false;
      this.recovery.updateAttemptIntent(false);
      statusStore.playStatus = false;
    }
    // 淡出
    const fadeTime = settingStore.getFadeTime ? settingStore.getFadeTime / 1000 : 0;
    await audioManager.pause({ fadeOut: !!fadeTime, fadeDuration: fadeTime });
  }
  /**
   * 播放或暂停
   */
  public async playOrPause(canAutoPlay?: () => boolean) {
    if (canAutoPlay && !canAutoPlay()) return;
    const statusStore = useStatusStore();
    if (statusStore.playStatus) await this.pause();
    else await this.play(canAutoPlay);
  }
  /**
   * 下一首或上一首
   * @param type 切换类别 next 下一首 prev 上一首
   * @param play 是否立即播放
   * @param autoEnd 是否为歌曲自动播放结束
   * @param canAutoPlay HTTP shell owner 存活检查
   */
  public async nextOrPrev(
    type: "next" | "prev" = "next",
    play: boolean = true,
    autoEnd: boolean = false,
    canAutoPlay?: () => boolean,
  ) {
    this.radioOperation = undefined;
    this.autoPlayIntent = play;
    this.autoPlayOwner = canAutoPlay;
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
        await this.nextRadio(false, true, canAutoPlay, play);
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
        await this.play(canAutoPlay);
        return;
      }
      // 单曲循环
      if (playSongMode === "repeat-once" && autoEnd) {
        statusStore.playLoading = false;
        this.setSeek(0);
        await this.play(canAutoPlay);
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
      await this.initPlayer(play, 0, "", canAutoPlay);
    } catch (error) {
      this.logPlaybackError("Error in nextOrPrev:", error);
      statusStore.playLoading = false;
      throw error;
    }
  }
  /** 本地临时封面变化沿用现有配色请求代次，不写入歌曲快照。 */
  public updateArtworkTheme(url: string): Promise<void> {
    return songManager.getCoverColor(url);
  }
  private nativeModeCoordinator() {
    if (!this.nativeModes) {
      const data = useDataStore();
      const status = useStatusStore();
      const music = useMusicStore();
      this.nativeModes = createNativePlayModeCoordinator({
        read: () => ({
          mode: status.playSongMode,
          playList: data.playList,
          originalPlayList: data.originalPlayList,
          playIndex: status.playIndex,
          currentSong: music.playSong,
          revision: data.playbackRevision,
        }),
        readOriginal: () => data.getOriginalPlayList(false),
        shuffle: (songs) => shuffleArray(songs),
        commit: (snapshot) => {
          data.$patch({
            playList: snapshot.playList,
            originalPlayList: snapshot.originalPlayList,
            playbackRevision: Symbol("playback"),
          });
          status.$patch({ playIndex: snapshot.playIndex, playSongMode: snapshot.mode });
        },
        persist: (snapshot) => data.persistPlayModeLists(snapshot),
      });
    }
    return this.nativeModes;
  }
  /**
   * 切换播放模式
   */
  public async togglePlayMode(mode: PlayModeType | false, isCurrent: () => boolean = () => true) {
    if (isMygo) {
      const result = await this.nativeModeCoordinator().request({ target: mode, isCurrent });
      if (result.status === "persist-failed" && isCurrent()) {
        window.$message?.warning(t("message.play_mode_save_failed"));
      }
      return result;
    }
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
    return undefined;
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
    statusStore.$persist?.();
    this.notifySeek();
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
      // 列表变化后，即使复用当前音频也要更新歌曲在新列表中的位置。
      statusStore.playIndex = processedData.findIndex(
        (item) => item.id === song.id && item.platform === song.platform,
      );
      // 是否为当前播放歌曲
      if (musicStore.playSong.id === song.id && musicStore.playSong.platform === song.platform) {
        if (play) await this.play();
      } else {
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
    if (statusStore.playSongMode === "shuffle") {
      await dataStore.addSongToOriginalList(song, musicStore.playSong);
    }
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
      this.logPlaybackError("Error in togglePlayIndex:", error);
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
    const targetSong = playList[index];
    // 是否为当前播放歌曲
    const isCurrentPlay = statusStore.playIndex === index;
    // 深拷贝，防止影响原数据
    const newPlaylist = cloneDeep(playList);
    // 若移除当前播放且为最后一首
    if (isCurrentPlay && index === playList.length - 1) {
      statusStore.playIndex = 0;
    }
    // 若为当前播放之后
    else if (statusStore.playIndex > index) {
      statusStore.playIndex--;
    }
    // 移除指定歌曲
    newPlaylist.splice(index, 1);
    dataStore.setPlayList(newPlaylist);
    if (statusStore.playSongMode === "shuffle" && targetSong) {
      dataStore.removeSongFromOriginalList(targetSong);
    }
    // 若为当前播放
    if (isCurrentPlay) {
      this.initPlayer(statusStore.playStatus);
    }
  }
  /**
   * 清空播放列表
   */
  public async cleanPlayList() {
    this.radioOperation = undefined;
    ++this.playRequestId;
    await audioManager.clearSource();
    this.recovery.closeHttpDialog();
    this.recovery.closeMpvDialog();
    this.recovery.clearAttempt();
    const dataStore = useDataStore();
    const statusStore = useStatusStore();
    await audioManager.stop();
    this.resetStatus();
    statusStore.resetPlayStatus();
    await dataStore.setPlayList([]);
    await dataStore.clearOriginalPlayList();
  }
  /** 保存设置后重新解析当前源；恢复阶段持续读取最新播放意图。 */
  public async changePlaybackOutput(engine?: PlaybackEngineId): Promise<void> {
    const setting = useSettingStore();
    if (engine) setting.playbackEngine = engine;
    const seek = this.getSeek();
    const status = useStatusStore();
    if (!status.playLoading) this.autoPlayIntent = status.playStatus;
    if (songManager.getPlaySongData()) {
      await this.initPlayer(true, seek, status.playQuality, this.autoPlayOwner, true);
    } else {
      ++this.playRequestId;
      await audioManager.clearSource();
      await audioManager.setEngine(isMygo ? setting.playbackEngine : "web-audio");
      await this.toggleOutputDevice();
    }
  }
  /**
   * 切换输出设备
   * @param deviceId 输出设备
   */
  public async toggleOutputDevice(deviceId?: string) {
    const settingStore = useSettingStore();
    const engine = isMygo ? (settingStore.playbackEngine ?? "web-audio") : "web-audio";
    const selected =
      deviceId ?? settingStore.outputDevices?.[engine]?.id ?? settingStore.playDevice;
    if (typeof selected !== "string") return;
    const id = !selected || selected === "default" ? (engine === "mpv" ? "auto" : "") : selected;
    try {
      if (id && id !== "auto") {
        const devices = await audioManager.getOutputDevices();
        if (!devices.some((device) => device.id === id && device.available)) {
          await audioManager.pause();
          throw new PlaybackOutputError(t("mygo.audio.device_unavailable"));
        }
      }
      await audioManager.setSinkId(id);
    } catch (error) {
      await Promise.resolve(audioManager.pause()).catch((pauseError: unknown) =>
        this.logPlaybackError("暂停输出失败:", pauseError),
      );
      if (error instanceof PlaybackOutputError) throw error;
      throw new PlaybackOutputError(t("message.output_device_change_failed"), { cause: error });
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
    const session = desktopLyricsSession.value;
    if (session?.ready.value) {
      this.requestNativeDesktopLyrics(
        !(session.window.value?.visible || session.window.value?.pending),
      );
    }
  }
  /**
   * 显式设置桌面歌词显示/隐藏
   * @param show 是否显示
   */
  public setDesktopLyricShow(show: boolean) {
    this.requestNativeDesktopLyrics(show);
  }

  private requestNativeDesktopLyrics(show: boolean): void {
    const session = desktopLyricsSession.value;
    if (!session?.ready.value) return;
    // 显示标记由主会话的窗口回执更新，pending 不能冒充窗口已打开。
    void session.requestVisible(show).catch(() => {
      window.$message?.error(t("message.desktop_lyrics_connection_failed"));
    });
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
    return selectPlaybackQuality(songInfo, {
      engine: isMygo ? settingStore.playbackEngine : "web-audio",
      requested: quality,
      configured: settingStore.songLevel,
      current: statusStore.playQuality,
      selected: statusStore.selectedQuality,
    });
  }

  /**
   * 初始化私人FM
   * @param init 是否初始化
   * @param playNext 是否播放下一首
   */
  async nextRadio(
    init: boolean = true,
    playNext: boolean = false,
    canAutoPlay?: () => boolean,
    autoPlay: boolean = true,
  ) {
    const operation = Symbol("radio");
    this.radioOperation = operation;
    this.recovery.closeMpvDialog();
    this.autoPlayIntent = autoPlay;
    this.autoPlayOwner = canAutoPlay;
    const requestId = this.playRequestId;
    const musicStore = useMusicStore();
    const statusStore = useStatusStore();
    const radio = musicStore.radio;
    const { id, platform } = radio;
    const isCurrent = () =>
      this.radioOperation === operation &&
      requestId === this.playRequestId &&
      musicStore.radio === radio &&
      radio.id === id &&
      radio.platform === platform;
    try {
      const loadPage = async (page: number) => {
        const result = await listRadioSongs(id, platform, page);
        // No radio state is published until this exact pre-init operation wins.
        if (!isCurrent()) return false;
        radio.playIndex = 0;
        if (!isCurrent()) return false;
        radio.list = result.list;
        if (!isCurrent()) return false;
        radio.pageIndex = result.page_index || page;
        return isCurrent();
      };
      if (init || radio.list.length === 0) {
        if (!(await loadPage(1))) return;
        if (!isCurrent()) return;
        statusStore.radioMode = true;
      } else if (playNext) {
        if (radio.playIndex < radio.list.length - 1) {
          if (!isCurrent()) return;
          radio.playIndex++;
        } else if (!(await loadPage(radio.pageIndex + 1 || 1))) return;
      } else return;
      if (!isCurrent()) return;
      this.resetStatus(isCurrent);
      if (!isCurrent()) return;
      // initPlayer consumes the token as it acquires a new source request.
      await this.initPlayer(this.autoPlayIntent, 0, "", canAutoPlay);
    } catch (error) {
      if (isCurrent()) this.logPlaybackError("Failed to initialize radio:", error);
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
