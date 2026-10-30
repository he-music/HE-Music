import { shallowRef } from "vue";
import { expect, it, vi } from "vitest";
import { mygoSongDownload, type MygoSongDownloadOwner } from "./mygoSongDownload";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";

function setup() {
  const task: LocalDownloadTask = {
    id: "failed",
    filename: "Song.mp3",
    label: "Song",
    quality: "320mp3",
    song: { id: "one", platform: "test" },
    phase: "failed",
    done: true,
    committed: false,
    received: 0,
    total: 0,
    percent: undefined,
    refresh: "none",
    retryable: true,
  };
  const tasks = shallowRef<readonly LocalDownloadTask[]>([task]);
  const queue = {
    tasks,
    retry: vi.fn(async () => "retried"),
    cancel: vi.fn(),
    refresh: vi.fn(),
    retire: vi.fn(),
  };
  const ready = shallowRef(true);
  const owner = shallowRef<MygoSongDownloadOwner | undefined>({ ready, downloads: queue });
  const song = { id: "one", platform: "test" };
  return { task, tasks, queue, owner, song, ready };
}
it("matches the source identity, gives active tasks priority and retries only their own queue", async () => {
  const f = setup();
  expect(mygoSongDownload(f.owner, { ...f.song, platform: "other" })).toBeUndefined();
  expect(mygoSongDownload(f.owner, { ...f.song, id: "other" })).toBeUndefined();
  const action = mygoSongDownload(f.owner, f.song)!;
  expect(await action.retry()).toBe("retried");
  expect(f.queue.retry).toHaveBeenCalledWith("failed");
  f.tasks.value = [
    f.task,
    { ...f.task, id: "active", done: false, phase: "active", retryable: false },
  ];
  expect(mygoSongDownload(f.owner, f.song)?.task.id).toBe("active");
  expect(await mygoSongDownload(f.owner, f.song)?.retry()).toBeUndefined();
  expect(f.queue.retry).toHaveBeenCalledTimes(1);
});
it("never retries saved tasks or tasks that disappeared while a menu was open", async () => {
  const f = setup();
  const action = mygoSongDownload(f.owner, f.song)!;
  f.tasks.value = [{ ...f.task, committed: true }];
  expect(mygoSongDownload(f.owner, f.song)).toBeUndefined();
  expect(await action.retry()).toBeUndefined();
  f.tasks.value = [];
  expect(await action.retry()).toBeUndefined();
  expect(f.queue.retry).not.toHaveBeenCalled();
});
it("invalidates open menu actions when the session changes or authorization becomes unavailable", async () => {
  const f = setup();
  const action = mygoSongDownload(f.owner, f.song)!;
  const previous = f.owner.value!;
  f.ready.value = false;
  expect(mygoSongDownload(f.owner, f.song)).toBeUndefined();
  expect(await action.retry()).toBeUndefined();
  f.ready.value = true;
  f.owner.value = { ...previous };
  expect(action.current()).toBe(false);
  expect(await action.retry()).toBeUndefined();
  f.owner.value = undefined;
  expect(await action.retry()).toBeUndefined();
  expect(f.queue.retry).not.toHaveBeenCalled();
});
