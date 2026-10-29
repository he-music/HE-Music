import type { SongInfo } from "@/types/main.hemusic";
import type { LocalFileActionAccess } from "./filesSession";
import type { FileActionResult } from "./mygo.bindings";

export interface LocalFileActionOutcome {
  readonly removed: boolean;
  readonly current: boolean;
}

export interface LocalFileActionsDependencies {
  access(song: SongInfo): LocalFileActionAccess | undefined;
  isPlaying(song: SongInfo): boolean;
  onRemoved(song: SongInfo): void;
}

/** UI confirmation belongs to the caller; this controller never grants authority from a path. */
export class LocalFileActions {
  constructor(private readonly deps: LocalFileActionsDependencies) {}

  async reveal(song: SongInfo): Promise<boolean> {
    const access = song.path ? this.deps.access({ ...song }) : undefined;
    if (!access?.current()) return false;
    try {
      const result = await access.reveal();
      return result.code === "ok" && access.current();
    } catch {
      return false;
    }
  }

  async remove(song: SongInfo): Promise<LocalFileActionOutcome> {
    const captured = { ...song };
    const access = captured.path ? this.deps.access(captured) : undefined;
    // Recheck when confirmation is accepted: playback may have changed while the dialog was open.
    if (!access?.current() || this.deps.isPlaying(captured)) {
      return { removed: false, current: false };
    }
    let result: FileActionResult;
    try {
      result = await access.remove();
    } catch {
      return { removed: false, current: access.current() };
    }
    const current = access.current();
    if (result.removed && current) {
      try {
        this.deps.onRemoved(captured);
      } catch {
        // Refresh failures cannot undo a committed deletion.
        console.error("文件已删除，但本地列表刷新失败");
      }
    }
    return { removed: result.removed, current };
  }
}
