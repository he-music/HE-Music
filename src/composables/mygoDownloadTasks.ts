import { computed, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import type { LocalDownloadSession, LocalDownloadTask } from "@/platform/localDownloadSession";

export interface MygoDownloadQueue extends Pick<
  LocalDownloadSession,
  "cancel" | "refresh" | "retry"
> {
  readonly tasks: Readonly<Ref<readonly LocalDownloadTask[]>>;
  retire(id: string): Promise<boolean>;
}
export interface MygoDownloadTasksOwner {
  readonly downloads?: MygoDownloadQueue;
}
export type DownloadTaskAction = "cancel" | "refresh" | "retry" | "retire";

/** View state only: FilesSession retains ownership of tasks, authorization and polling. */
export function useMygoDownloadTasks(owner: Readonly<Ref<MygoDownloadTasksOwner | undefined>>) {
  const queue = computed(() => owner.value?.downloads);
  const tasks = computed<readonly LocalDownloadTask[]>(() => queue.value?.tasks.value ?? []);
  const pending = shallowRef<ReadonlyMap<string, symbol>>(new Map());
  const errors = shallowRef<ReadonlySet<string>>(new Set());
  let active = true;
  watch(
    [queue, () => tasks.value.map((task) => task.id)],
    ([current, ids], [previous]) => {
      const keep = new Set(current === previous ? ids : []);
      pending.value = new Map([...pending.value].filter(([id]) => keep.has(id)));
      errors.value = new Set([...errors.value].filter((id) => keep.has(id)));
    },
    { flush: "sync" },
  );
  onScopeDispose(() => {
    active = false;
    pending.value = new Map();
    errors.value = new Set();
  });

  async function run(id: string, action: DownloadTaskAction): Promise<boolean> {
    const captured = queue.value;
    const task = tasks.value.find((item) => item.id === id);
    if (!active || !captured || !task || pending.value.has(id)) return false;
    if (action === "retire" && (!task.done || task.refresh === "pending")) return false;
    if (action === "retry" && !task.retryable) return false;
    if ((action === "cancel" || action === "refresh") && task.done) return false;
    const ticket = Symbol(id);
    pending.value = new Map(pending.value).set(id, ticket);
    errors.value = new Set([...errors.value].filter((item) => item !== id));
    const current = () => active && queue.value === captured && pending.value.get(id) === ticket;
    try {
      let succeeded = true;
      if (action === "retry") succeeded = (await captured.retry(id)) !== undefined;
      else if (action === "retire") succeeded = await captured.retire(id);
      else await captured[action](id);
      if (!current()) return false;
      if (!succeeded) errors.value = new Set(errors.value).add(id);
      return succeeded;
    } catch {
      if (current()) errors.value = new Set(errors.value).add(id);
      return false;
    } finally {
      if (current()) {
        const next = new Map(pending.value);
        next.delete(id);
        pending.value = next;
      }
    }
  }

  const removable = computed(() =>
    tasks.value.filter((task) => task.done && task.refresh !== "pending"),
  );
  async function clearDone(): Promise<void> {
    const captured = queue.value;
    const ids = removable.value.map((task) => task.id);
    for (const id of ids) {
      if (!active || queue.value !== captured) return;
      await run(id, "retire");
    }
  }
  return { tasks, pending, errors, removable, run, clearDone };
}
