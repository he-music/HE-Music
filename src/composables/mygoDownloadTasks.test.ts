import { effectScope, shallowRef, type Ref } from "vue";
import { expect, it, vi } from "vitest";
import {
  useMygoDownloadTasks,
  type MygoDownloadQueue,
  type MygoDownloadTasksOwner,
} from "./mygoDownloadTasks";
import { LocalDownloadSession, type LocalDownloadTask } from "@/platform/localDownloadSession";

const task = (id = "one", changes: Partial<LocalDownloadTask> = {}): LocalDownloadTask => ({
  id,
  filename: `${id}.mp3`,
  label: id,
  quality: "320mp3",
  phase: "active",
  done: false,
  committed: false,
  received: 0,
  total: 0,
  percent: undefined,
  refresh: "none",
  retryable: false,
  ...changes,
});
function queue(rows = [task()]): MygoDownloadQueue & { tasks: Ref<readonly LocalDownloadTask[]> } {
  const tasks = shallowRef<readonly LocalDownloadTask[]>(rows);
  return {
    tasks,
    cancel: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    retry: vi.fn(async () => "new"),
    remove: vi.fn(async (id) => {
      tasks.value = tasks.value.filter((row) => row.id !== id);
      return true;
    }),
    retire: vi.fn(async (id) => {
      tasks.value = tasks.value.filter((row) => row.id !== id);
      return true;
    }),
  };
}
function setup(downloads = queue()) {
  const owner = shallowRef<MygoDownloadTasksOwner | undefined>({ downloads });
  const scope = effectScope();
  const view = scope.run(() => useMygoDownloadTasks(owner));
  if (!view) throw new Error("Missing view");
  return { owner, scope, view, downloads };
}
it("uses the same queue across page scopes and stops only view listeners", async () => {
  const first = setup();
  expect(first.view.tasks.value).toBe(first.downloads.tasks.value);
  first.scope.stop();
  first.downloads.tasks.value = [task("continued", { received: 1024 })];
  const second = setup(first.downloads);
  expect(second.view.tasks.value[0].received).toBe(1024);
  await second.view.run("continued", "cancel");
  expect(first.downloads.cancel).toHaveBeenCalledWith("continued");
  second.scope.stop();
});
it("deduplicates all operations per ID and ignores late owner/grant results", async () => {
  const first = setup();
  let finish: (() => void) | undefined;
  first.downloads.cancel = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = first.view.run("one", "cancel");
  expect(await first.view.run("one", "refresh")).toBe(false);
  expect(first.downloads.refresh).not.toHaveBeenCalled();
  first.downloads.tasks.value = [];
  expect(first.view.pending.value.size).toBe(0);
  const next = queue();
  first.owner.value = { downloads: next };
  finish?.();
  expect(await pending).toBe(false);
  expect(first.view.errors.value.size).toBe(0);
  await first.view.run("one", "refresh");
  expect(next.refresh).toHaveBeenCalledOnce();
  first.scope.stop();
});
it("retries failed tasks, keeps retirement failures, clears only eligible done rows", async () => {
  const downloads = queue([
    task("failed", { phase: "failed", done: true, retryable: true }),
    task("success", { phase: "success", done: true, committed: true }),
    task("scan", { phase: "success", done: true, refresh: "pending" }),
    task("active"),
  ]);
  const { view, scope } = setup(downloads);
  downloads.retry = vi.fn(async () => undefined);
  await view.run("failed", "retry");
  expect(view.errors.value.has("failed")).toBe(true);
  downloads.retry = vi.fn(async () => "retried");
  expect(await view.run("failed", "retry")).toBe(true);
  expect(view.errors.value.has("failed")).toBe(false);
  downloads.retire = vi.fn(async () => false);
  await view.clearDone();
  expect(downloads.retire).toHaveBeenCalledTimes(3);
  expect(view.errors.value.has("success")).toBe(true);
  expect(view.tasks.value).toHaveLength(4);
  scope.stop();
});
it("retries only unsaved retryable tasks and stops the snapshot when its owner changes", async () => {
  const first = setup(
    queue([
      task("failed", { done: true, retryable: true }),
      task("saved", { done: true, committed: true, retryable: true }),
      task("active"),
      task("second", { done: true, retryable: true }),
    ]),
  );
  expect(first.view.retryable.value.map((item) => item.id)).toEqual(["failed", "second"]);
  first.downloads.retry = vi.fn(async () => {
    first.owner.value = { downloads: queue([task("second", { done: true, retryable: true })]) };
    return "retried";
  });
  await first.view.retryAll();
  expect(first.downloads.retry).toHaveBeenCalledExactlyOnceWith("failed");
  expect(first.owner.value?.downloads?.retry).not.toHaveBeenCalled();
  first.scope.stop();
});
it("clears a snapshot without retiring a replacement owner's IDs", async () => {
  const first = setup(queue([task("one", { done: true }), task("two", { done: true })]));
  first.downloads.retire = vi.fn(async () => {
    first.owner.value = { downloads: queue([task("two", { done: true })]) };
    return true;
  });
  await first.view.clearDone();
  expect(first.downloads.retire).toHaveBeenCalledTimes(1);
  expect(first.owner.value?.downloads?.retire).not.toHaveBeenCalled();
  first.scope.stop();
});
it("does not add a poller or stop real session downloads when a page scope closes", async () => {
  vi.useFakeTimers();
  let viewScope = effectScope();
  const read = vi.fn(async (id: string) => ({
    operationId: id,
    code: "running",
    done: false,
    committed: false,
    received: 128,
    total: 256,
  }));
  const session = new LocalDownloadSession({
    access: () => ({
      current: () => true,
      start: async (request) => ({ operationId: request.operationId }),
      read,
      cancel: read,
    }),
    onCommitted: async () => {},
  });
  // Only retirement is a fake: its production method is supplied by the dependency integration.
  const downloads: MygoDownloadQueue = {
    tasks: session.tasks,
    refresh: (id) => session.refresh(id),
    cancel: (id) => session.cancel(id),
    retry: (id) => session.retry(id),
    remove: (id) => session.remove(id),
    retire: async () => false,
  };
  const owner = shallowRef<MygoDownloadTasksOwner | undefined>({ downloads });
  try {
    await session.start({
      grantToken: "fake",
      filename: "song.mp3",
      label: "Song",
      quality: "320",
      url: "https://example.test/song",
      source: { id: "song", name: "Song", platform: "fake", links: [] },
      resolveURL: async () => ({ url: "https://example.test/song", format: "mp3" }),
    });
    const before = vi.getTimerCount();
    viewScope.run(() => useMygoDownloadTasks(owner));
    expect(vi.getTimerCount()).toBe(before);
    viewScope.stop();
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalled();
    expect(session.tasks.value[0].received).toBe(128);
    viewScope = effectScope();
    const view = viewScope.run(() => useMygoDownloadTasks(owner));
    expect(view?.tasks.value).toBe(session.tasks.value);
    session.invalidate("fake");
    expect(view?.tasks.value).toEqual([]);
  } finally {
    viewScope.stop();
    session.dispose();
    await vi.advanceTimersByTimeAsync(3001);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
