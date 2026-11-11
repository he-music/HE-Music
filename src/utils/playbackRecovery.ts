import { h } from "vue";
import type { DialogReactive } from "naive-ui";
import { t } from "@/i18n";
import type { AudioSourceInfo } from "./audioCapability";
import type { PlaybackEngineId, PlaybackError } from "@/core/audio-player/IPlaybackEngine";

interface PlaybackAttempt {
  src: string;
  autoPlay: boolean;
  seek: number;
  requestId: number;
  source?: AudioSourceInfo;
  canAutoPlay?: () => boolean;
}

export interface PlaybackRecoveryDependencies {
  audio: {
    readonly engineId: PlaybackEngineId;
    readonly error?: PlaybackError;
    getErrorCode(): number;
    pause(): Promise<void>;
  };
  isMygo(): boolean;
  getRequestId(): number;
  hasRadioOperation(): boolean;
  clearRadioOperation(): void;
  getAutoPlayIntent(): boolean;
  getAutoPlayOwner(): (() => boolean) | undefined;
  revokeAutoPlay(): void;
  getStatus(): { playStatus: boolean; playLoading: boolean; playQuality: string };
  getSong(): { id: string | number; platform: string } | null | undefined;
  getPlaylistLength(): number;
  getSeek(): number;
  getSongLogInfo(): string;
  logError(message: string, error: unknown): void;
  selectMpv(): void;
  initPlayer(
    autoPlay: boolean,
    seek: number,
    quality?: string,
    canAutoPlay?: () => boolean,
    preserveIntent?: boolean,
  ): Promise<void>;
  createPlayer(
    src: string,
    autoPlay: boolean,
    seek: number,
    canAutoPlay?: () => boolean,
    source?: AudioSourceInfo,
  ): Promise<void>;
  next(play?: boolean, auto?: boolean, canAutoPlay?: () => boolean): Promise<void>;
}

/** 只维护失败恢复；请求所有权和播放意图由 Player 提供。 */
export class PlaybackRecovery {
  private lastErrorTime = 0;
  private retryInfo = { songId: "", count: 0, total: 0 };
  private playbackAttempt?: PlaybackAttempt;
  private httpPlaybackDialog?: DialogReactive;
  private mpvPlaybackDialog?: DialogReactive;
  private mpvRetryRequestId?: number;
  private lastHttpRetrySrc = "";

  constructor(private readonly deps: PlaybackRecoveryDependencies) {}

  public recordAttempt(attempt: PlaybackAttempt): void {
    this.playbackAttempt = attempt;
  }

  public updateAttemptIntent(autoPlay: boolean, canAutoPlay?: () => boolean): void {
    if (!this.playbackAttempt) return;
    this.playbackAttempt.autoPlay = autoPlay;
    if (autoPlay) this.playbackAttempt.canAutoPlay = canAutoPlay;
  }

  public cancelAttemptAutoplay(requestId: number): void {
    if (this.playbackAttempt?.requestId === requestId) this.playbackAttempt.autoPlay = false;
  }

  public clearAttempt(): void {
    this.playbackAttempt = undefined;
  }

  public closeHttpDialog(): void {
    this.httpPlaybackDialog?.destroy();
    this.httpPlaybackDialog = undefined;
  }

  public closeMpvDialog(): void {
    this.mpvPlaybackDialog?.destroy();
    this.mpvPlaybackDialog = undefined;
  }

  public onCanPlay(songIdentity: string): void {
    this.retryInfo = { songId: songIdentity, count: 0, total: 0 };
  }

  public handleMediaError(errorCode: number, errorMessage?: string): void {
    if (
      this.deps.audio.engineId === "mpv" ||
      this.deps.audio.error?.kind === "device" ||
      this.deps.audio.error?.kind === "engine"
    ) {
      this.deps.revokeAutoPlay();
      const status = this.deps.getStatus();
      status.playStatus = false;
      status.playLoading = false;
      void this.deps.audio
        .pause()
        .catch((error: unknown) => this.deps.logError("暂停失败:", error));
      window.$message.error(errorMessage || t("message.song_play_fail"));
      return;
    }
    if (this.offerHttpsRetry(errorCode)) return;
    if (this.offerMpvRetry(errorCode)) return;
    this.handlePlaybackError(errorCode);
  }
  /** 媒体错误只能提示兼容性可能性；由用户决定是否切换原生引擎重试。 */
  private offerMpvRetry(errorCode: number): boolean {
    const attempt = this.playbackAttempt;
    if (
      !this.deps.isMygo() ||
      this.deps.audio.engineId !== "web-audio" ||
      (errorCode !== 3 && errorCode !== 4) ||
      this.httpPlaybackDialog ||
      !attempt ||
      attempt.requestId !== this.deps.getRequestId() ||
      this.deps.audio.error?.kind === "device" ||
      this.deps.audio.error?.kind === "engine" ||
      this.deps.audio.error?.kind === "network"
    ) {
      return false;
    }
    if (this.mpvRetryRequestId === attempt.requestId) return true;
    this.mpvRetryRequestId = attempt.requestId;
    const status = this.deps.getStatus();
    status.playStatus = false;
    status.playLoading = false;
    void this.deps.audio.pause().catch((error: unknown) => this.deps.logError("暂停失败:", error));
    let settled = false;
    const isCurrent = () =>
      !settled &&
      attempt.requestId === this.deps.getRequestId() &&
      !this.deps.hasRadioOperation() &&
      this.deps.audio.engineId === "web-audio";
    const dismiss = () => {
      if (!isCurrent()) return;
      settled = true;
      this.mpvPlaybackDialog = undefined;
      this.deps.revokeAutoPlay();
      attempt.autoPlay = false;
    };
    this.mpvPlaybackDialog = window.$dialog.warning({
      title: t("mygo.audio.compatibility_title"),
      content: t("mygo.audio.compatibility_hint"),
      positiveText: t("mygo.audio.switch_to_mpv"),
      negativeText: t("common.cancel"),
      onPositiveClick: async () => {
        if (!isCurrent()) return;
        settled = true;
        this.mpvPlaybackDialog = undefined;
        const seek = Math.max(attempt.seek, this.deps.getSeek());
        this.deps.selectMpv();
        const requestId = this.deps.getRequestId() + 1;
        try {
          await this.deps.initPlayer(
            true,
            seek,
            status.playQuality,
            this.deps.getAutoPlayOwner(),
            true,
          );
        } catch (error) {
          if (requestId !== this.deps.getRequestId()) return;
          this.deps.logError("切换 mpv 重试失败:", error);
          window.$message.error(t("mygo.audio.engine_change_failed"));
        }
      },
      onNegativeClick: dismiss,
      onClose: dismiss,
      onMaskClick: dismiss,
      onEsc: dismiss,
    });
    return true;
  }
  /** HTTP 地址失败时提供 HTTPS 排查入口；媒体错误码无法判断证书是否有效。 */
  private offerHttpsRetry(errorCode: number): boolean {
    const attempt = this.playbackAttempt;
    if (
      window.location.protocol !== "https:" ||
      (errorCode !== 2 && errorCode !== 4) ||
      !attempt ||
      attempt.requestId !== this.deps.getRequestId() ||
      !/^http:\/\//i.test(attempt.src)
    ) {
      return false;
    }
    if (this.httpPlaybackDialog) return true;
    if (this.lastHttpRetrySrc === attempt.src) return false;
    this.lastHttpRetrySrc = attempt.src;
    const httpsUrl = new URL(attempt.src);
    httpsUrl.protocol = "https:";
    const statusStore = this.deps.getStatus();
    const seek = Math.max(attempt.seek, this.deps.getSeek());
    statusStore.playLoading = false;
    statusStore.playStatus = false;
    let settled = false;
    const isCurrent = () => !settled && attempt.requestId === this.deps.getRequestId();
    const dismiss = () => {
      if (!isCurrent()) return;
      settled = true;
      this.httpPlaybackDialog = undefined;
      void this.handlePlaybackError(errorCode);
    };
    this.httpPlaybackDialog = window.$dialog.warning({
      title: "音源 HTTPS 访问失败排查",
      content: () =>
        h("div", { style: { lineHeight: "1.6" } }, [
          h(
            "p",
            null,
            "当前 HTTP 音源加载失败，可能与 HTTPS 页面的安全限制有关，也可能是链接过期、网络或格式问题。",
          ),
          h(
            "p",
            null,
            "可打开 HTTPS 地址检查。仅在确认音源可信且浏览器允许时，手动处理证书提示，然后返回重试。服务端不支持 HTTPS 时，此操作无法解决。",
          ),
          h("p", null, "关闭此提示将继续原有播放错误处理。"),
        ]),
      positiveText: "打开 HTTPS 地址",
      negativeText: "返回后重试",
      onPositiveClick: () => {
        if (!isCurrent()) return;
        window.open(httpsUrl.href, "_blank", "noopener,noreferrer");
        return false;
      },
      onNegativeClick: () => {
        if (!isCurrent()) return;
        this.deps.clearRadioOperation();
        settled = true;
        this.httpPlaybackDialog = undefined;
        void this.deps
          .createPlayer(httpsUrl.href, attempt.autoPlay, seek, attempt.canAutoPlay, attempt.source)
          .catch((error: unknown) => {
            if (attempt.requestId !== this.deps.getRequestId()) return;
            this.deps.logError("HTTPS 重试播放失败:", error);
            // 媒体 error 事件负责普通错误；没有媒体错误码时补上恢复逻辑。
            if (this.deps.audio.getErrorCode() === 0) void this.handlePlaybackError();
          });
      },
      onClose: dismiss,
      onMaskClick: dismiss,
      onEsc: dismiss,
    });
    return true;
  }
  public handlePlayRejection(error: unknown): boolean {
    if (error instanceof Error && error.name === "NotAllowedError") {
      const statusStore = this.deps.getStatus();
      statusStore.playLoading = false;
      statusStore.playStatus = false;
      window.$message.error(t("message.song_play_fail"));
      return true;
    }
    return this.offerMpvRetry(
      error instanceof Error && error.name === "NotSupportedError"
        ? 4
        : this.deps.audio.getErrorCode(),
    );
  }
  public async handlePlaybackError(errCode?: number) {
    // 错误防抖
    const now = Date.now().valueOf();
    if (now - this.lastErrorTime < 200) return;
    this.lastErrorTime = now;
    const playSongData = this.deps.getSong();
    const currentSongId = `${playSongData?.id}-${playSongData?.platform}`;
    // 初始化/切换曲目时重置计数
    if (!this.retryInfo.songId || this.retryInfo.songId !== currentSongId) {
      this.retryInfo = { songId: currentSongId, count: 0, total: this.retryInfo.total };
    }
    this.retryInfo.count += 1;
    this.retryInfo.total += 1;

    console.log(
      `Playback retry: ${this.deps.getSongLogInfo()}; count=${this.retryInfo.count}, total=${this.retryInfo.total}`,
    );
    // 错误码 2：资源过期或临时网络错误，允许较少次数的刷新
    if (errCode === 2 && this.retryInfo.count <= 2) {
      if (this.deps.getAutoPlayOwner())
        await this.deps.initPlayer(
          this.deps.getAutoPlayIntent(),
          this.deps.getSeek(),
          "",
          this.deps.getAutoPlayOwner(),
        );
      else await this.deps.initPlayer(this.deps.getAutoPlayIntent(), this.deps.getSeek());
      return;
    }

    if (this.retryInfo.count == 4 || this.retryInfo.total >= 15) {
      window.$message.error("播放错误次数过多，已停止播放");
      return;
    }
    if (this.deps.getPlaylistLength() > 1) {
      window.$message.error("当前歌曲播放失败，已跳至下一首");
      if (this.deps.getAutoPlayIntent() && !this.deps.getAutoPlayOwner()) await this.deps.next();
      else await this.deps.next(this.deps.getAutoPlayIntent(), false, this.deps.getAutoPlayOwner());
    } else {
      window.$message.error(t("message.no_playable_song"));
    }
  }
}
