import type { Ref } from "vue";
import type { SongInfo } from "@/types/main.hemusic";
import type { MygoDownloadQueue } from "./mygoDownloadTasks";

export interface MygoSongDownloadOwner {
  readonly ready: Readonly<Ref<boolean>>;
  readonly downloads?: MygoDownloadQueue;
}

export function mygoSongDownload(
  ownerRef: Readonly<Ref<MygoSongDownloadOwner | undefined>>,
  song: Pick<SongInfo, "id" | "platform">,
) {
  const owner = ownerRef.value;
  const queue = owner?.downloads;
  if (!owner?.ready.value || !queue) return;
  const matches = queue.tasks.value.filter(
    (task) => task.song?.id === song.id && task.song.platform === song.platform,
  );
  const task =
    matches.find((item) => !item.done && !item.committed) ??
    matches.filter((item) => item.retryable && !item.committed).at(-1);
  if (!task) return;
  const current = () => ownerRef.value === owner && owner.ready.value && owner.downloads === queue;
  return {
    task,
    current,
    retry: () => {
      const latest = queue.tasks.value.find((item) => item.id === task.id);
      if (!current() || !latest?.retryable || latest.committed) return Promise.resolve(undefined);
      return queue.retry(task.id);
    },
  };
}
