import { useMusicStore, useSettingStore } from "@/stores";
import { hasNativeSystemMedia } from "./env";
import songManager from "./songManager";
import { msToS } from "./time";

interface MediaControls {
  play(): unknown;
  pause(): unknown;
  nextOrPrev(direction: "next" | "prev"): unknown;
  setSeek(milliseconds: number): void;
}

/** 浏览器系统媒体同步；原生桌面媒体继续由平台会话管理。 */
export class BrowserMediaSession {
  private available(): boolean {
    return !hasNativeSystemMedia && useSettingStore().smtcOpen && "mediaSession" in navigator;
  }

  init(player: MediaControls): void {
    if (!this.available() || typeof navigator.mediaSession.setActionHandler !== "function") return;
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // 部分宿主只实现了 MediaSession 的部分 action。
      }
    };
    setHandler("play", () => player.play());
    setHandler("pause", () => player.pause());
    setHandler("previoustrack", () => player.nextOrPrev("prev"));
    setHandler("nexttrack", () => player.nextOrPrev("next"));
    setHandler("seekto", (event) => {
      const seekTime = Number(event.seekTime) * 1000;
      if (Number.isFinite(seekTime) && seekTime >= 0) player.setSeek(seekTime);
    });
  }

  updateMetadata(): void {
    if (!this.available() || typeof window.MediaMetadata !== "function") return;
    const song = songManager.getPlaySongData();
    if (!song) return;
    const music = useMusicStore();
    const metadata: MediaMetadataInit = {
      title: song.name,
      artist: Array.isArray(song.artists)
        ? song.artists.map((artist) => artist.name).join(" / ")
        : String(song.artists),
      album: typeof song.album === "object" ? song.album.name : String(song.album),
      artwork: [1000, 700, 500].map((size) => ({
        src: music.getSongCover(size),
        sizes: `${size}x${size}`,
        type: "image/jpeg",
      })),
    };
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata(metadata);
    } catch {
      // 宿主可能尚未实现 metadata 写入，不能阻断歌曲初始化。
    }
  }

  updatePosition(duration: number, currentTime: number): void {
    if (!this.available() || typeof navigator.mediaSession.setPositionState !== "function") return;
    const seconds = msToS(duration);
    const position = msToS(currentTime);
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(position) || position < 0)
      return;
    try {
      navigator.mediaSession.setPositionState({
        duration: seconds,
        position: Math.min(position, seconds),
      });
    } catch {
      // 忽略部分平台或过渡状态下的 MediaSession 临时异常。
    }
  }
}
