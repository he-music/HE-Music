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

/** Only the native first slice is exposed: no configuration or locking methods. */
export interface PlatformDesktopLyrics extends Readonly<typeof DesktopLyrics> {
  onWindow(listener: (state: LyricsWindowState) => void): () => void;
  onSnapshot(listener: (snapshot: LyricsSnapshot) => void): () => void;
  onClock(listener: (clock: LyricsClock) => void): () => void;
  onCommand(listener: (command: LyricsCommand) => void): () => void;
}
