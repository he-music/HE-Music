import type {
  DesktopLyrics,
  LyricsClock,
  LyricsCommand,
  LyricsSnapshot,
  LyricsWindowState,
} from "./mygo.bindings";

export type {
  LyricsAction,
  LyricsAttachment,
  LyricsBounds,
  LyricsClock,
  LyricsCommand,
  LyricsLine,
  LyricsSession,
  LyricsSnapshot,
  LyricsWindowState,
  LyricsWord,
} from "./mygo.bindings";

/** Native provider with explicit window state, locking and external tray recovery. */
export interface PlatformDesktopLyrics extends Readonly<
  Omit<typeof DesktopLyrics, "resetPosition" | "setUnlockRegion">
> {
  resetPosition?: typeof DesktopLyrics.resetPosition;
  setUnlockRegion?: typeof DesktopLyrics.setUnlockRegion;
  onWindow(listener: (state: LyricsWindowState) => void): () => void;
  onSnapshot(listener: (snapshot: LyricsSnapshot) => void): () => void;
  onClock(listener: (clock: LyricsClock) => void): () => void;
  onCommand(listener: (command: LyricsCommand) => void): () => void;
}
