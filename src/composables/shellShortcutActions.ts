import type { LocalFileRef, ScanEntry } from "@/platform/mygo.bindings";
import type { GlobalShortcutAction } from "@/platform/shortcuts";
import type { DesktopLyricsSession } from "@/platform/desktopLyricsSession";

interface ShortcutSong {
  readonly id?: string;
  readonly path?: string;
  readonly platform?: string;
}
interface ShortcutFiles {
  readonly ready: { readonly value: boolean };
  readonly directories: { readonly value: readonly { token: string }[] };
}
type ShortcutLyrics = Pick<DesktopLyricsSession, "ready" | "window" | "requestVisible">;

export interface ShellShortcutActionDependencies {
  /** Return the current Ready shell identity; undefined means retired/unavailable. */
  owner(): unknown;
  song(): ShortcutSong | undefined;
  files(): ShortcutFiles | undefined;
  localEntry(id: string): ScanEntry | undefined;
  lyrics(): ShortcutLyrics | undefined;
  player: {
    playOrPause(): Promise<unknown>;
    nextOrPrev(direction: "prev" | "next"): Promise<unknown>;
    setVolume(direction: "up" | "down"): void;
  };
  reportFailure(error: unknown, action: GlobalShortcutAction): void;
}

function sameRef(left: LocalFileRef | undefined, right: LocalFileRef): boolean {
  return (
    left?.fileId === right.fileId &&
    left.version === right.version &&
    left.grantToken === right.grantToken &&
    left.relativePath === right.relativePath
  );
}

/** One controller per shell; it borrows existing files/lyrics owners and never starts them. */
export function createShellShortcutActions(deps: ShellShortcutActionDependencies) {
  let disposed = false;
  let lyricsBusy = false;

  const handle = (action: GlobalShortcutAction): Promise<void> => {
    const owner = deps.owner();
    const current = () => !disposed && owner !== undefined && deps.owner() === owner;
    if (!current()) return Promise.resolve();
    let execute: () => void | Promise<unknown>;
    let valid = current;
    let toggle = false;
    switch (action) {
      case "volumeUp":
      case "volumeDown":
        execute = () => deps.player.setVolume(action === "volumeUp" ? "up" : "down");
        break;
      case "playOrPause":
      case "playPrev":
      case "playNext": {
        const song = deps.song();
        if (!song?.id) return Promise.resolve();
        const id = song.id;
        const path = song.path;
        const platform = song.platform;
        const files = deps.files();
        const entry = deps.localEntry(id);
        // A native ID is local even if a malformed persisted song omitted its path.
        const local = Boolean(path || id.startsWith("mygo-local:"));
        const ref = entry ? { ...entry.ref } : undefined;
        if (
          local &&
          (!path ||
            entry?.relativePath !== path ||
            ref?.relativePath !== path ||
            (platform !== undefined && platform !== "local") ||
            !files?.ready.value ||
            !files.directories.value.some((grant) => grant.token === ref?.grantToken))
        )
          return Promise.resolve();
        valid = () => {
          const next = deps.song();
          return (
            current() &&
            next === song &&
            next.id === id &&
            next.path === path &&
            next.platform === platform &&
            (!local ||
              (deps.files() === files &&
                files?.ready.value === true &&
                ref !== undefined &&
                files.directories.value.some((grant) => grant.token === ref.grantToken) &&
                deps.localEntry(id)?.relativePath === path &&
                sameRef(deps.localEntry(id)?.ref, ref)))
          );
        };
        execute = () =>
          action === "playOrPause"
            ? deps.player.playOrPause()
            : deps.player.nextOrPrev(action === "playPrev" ? "prev" : "next");
        break;
      }
      case "toggleDesktopLyric": {
        const lyrics = deps.lyrics();
        if (lyricsBusy || !lyrics?.ready.value) return Promise.resolve();
        const visible = !lyrics.window.value?.visible;
        valid = () => current() && deps.lyrics() === lyrics && lyrics.ready.value;
        lyricsBusy = true;
        toggle = true;
        execute = () => lyrics.requestVisible(visible);
        break;
      }
      default:
        return Promise.resolve();
    }
    // Capture at the event entry, then recheck before crossing into a side-effecting owner.
    return Promise.resolve()
      .then(async () => {
        if (valid()) await execute();
      })
      .catch((error: unknown) => {
        if (valid()) deps.reportFailure(error, action);
      })
      .finally(() => {
        if (toggle) lyricsBusy = false;
      });
  };

  return {
    handle,
    dispose: () => {
      disposed = true;
    },
  };
}
