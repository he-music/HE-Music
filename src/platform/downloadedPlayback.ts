import type { Ref } from "vue";
import type { PlaybackEngineId } from "@/core/audio-player/IPlaybackEngine";
import type { SongInfo } from "@/types/main.hemusic";
import type { AudioSourceInfo } from "@/utils/audioCapability";
import type { DirectoryGrant, ScanEntry } from "./mygo.bindings";
import type { LocalDownloadTask } from "./localDownloadSession";
import { localResourceURL } from "./localResource";

export interface DownloadedPlaybackOwner {
  readonly ready: Readonly<Ref<boolean>>;
  readonly directories: Readonly<Ref<readonly DirectoryGrant[]>>;
  readonly libraryEntries: readonly ScanEntry[];
  readonly downloads?: { readonly tasks: Readonly<Ref<readonly LocalDownloadTask[]>> };
}
export interface DownloadedPlayback {
  readonly key: string;
  readonly entry: ScanEntry;
  readonly url: string;
  readonly source: AudioSourceInfo;
}

/** 在线歌曲保持原身份，仅从当前授权曲库中选择同音质的已下载文件。 */
export async function resolveDownloadedPlayback(
  song: SongInfo,
  quality: string,
  engine: PlaybackEngineId,
  owner: DownloadedPlaybackOwner | undefined,
  current: () => boolean,
  excluded: ReadonlySet<string>,
  request: typeof fetch = fetch,
): Promise<DownloadedPlayback | undefined> {
  if (!owner?.ready.value || !current() || !quality) return;
  const tasks =
    owner.downloads?.tasks.value.filter(
      (task) =>
        task.done &&
        task.committed &&
        (task.phase === "success" || task.phase === "saved") &&
        task.song?.id === song.id &&
        task.song.platform === song.platform &&
        task.quality === quality,
    ) ?? [];
  tasks.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  const deadline = Date.now() + 2000;
  for (const task of tasks) {
    if (!task.target || !current()) continue;
    const target = task.target;
    const grant = owner.directories.value.find((item) => item.displayPath === target.directory);
    if (!grant) continue;
    const entry = owner.libraryEntries.find(
      (item) =>
        item.ref.grantToken === grant.token &&
        item.relativePath === target.relativePath &&
        item.ref.relativePath === target.relativePath,
    );
    if (!entry?.path || entry.size <= 0) continue;
    const key = `${task.id}:${entry.ref.version}`;
    if (excluded.has(key)) continue;
    const format = entry.path.split(".").pop()?.toLowerCase() ?? "";
    if (engine !== "mpv" && ["ape", "dsf", "dff", "dsd", "wma"].includes(format)) continue;
    const url = localResourceURL("audio", entry);
    if (!url) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const stillCurrent = () =>
      current() &&
      owner.ready.value &&
      owner.directories.value.some(
        (item) => item.token === grant.token && item.epoch === grant.epoch,
      ) &&
      owner.libraryEntries.includes(entry) &&
      owner.downloads?.tasks.value.some(
        (item) => item.id === task.id && item.done && item.committed,
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      // HEAD 只确认文件仍可读取；失效记录直接回退在线取源。
      const response = await request(url, {
        method: "HEAD",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!stillCurrent()) return;
      if (!response.ok) continue;
      return {
        key,
        entry,
        url,
        source: {
          platform: "local",
          format,
          ...(engine === "mpv"
            ? {
                localRef: entry.ref,
                fileEpoch: grant.epoch,
                identity: `${song.platform}:${song.id}`,
              }
            : {}),
        },
      };
    } catch {
      if (!stillCurrent()) return;
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}
