import { getCurrentScope, onScopeDispose, ref, type Ref } from "vue";

export interface PageResult<T> {
  list: T[];
  has_more?: boolean;
  last_id?: string;
}

/** Commit pagination only after success; a failed page remains the retry target. */
export function usePagedRequest<T>(
  fetchPage: (page: number, cursor: string) => Promise<PageResult<T>>,
) {
  const data = ref<T[]>([]) as Ref<T[]>;
  const loading = ref(true);
  const failed = ref(false);
  const hasMore = ref(true);
  let page = 0;
  let cursor = "";
  let generation = 0;
  let pending = false;

  const retry = async () => {
    if (pending || !hasMore.value) return;
    const currentGeneration = generation;
    const targetPage = page + 1;
    pending = true;
    loading.value = true;
    failed.value = false;
    try {
      const result = await fetchPage(targetPage, cursor);
      if (currentGeneration !== generation) return;
      data.value = [...data.value, ...result.list];
      page = targetPage;
      cursor = result.last_id ?? "";
      hasMore.value = Boolean(result.has_more);
    } catch {
      if (currentGeneration === generation) failed.value = true;
    } finally {
      if (currentGeneration === generation) {
        loading.value = false;
        pending = false;
      }
    }
  };

  const loadMore = async () => {
    if (!failed.value) await retry();
  };

  const reset = () => {
    generation++;
    pending = false;
    page = 0;
    cursor = "";
    data.value = [];
    hasMore.value = true;
    return retry();
  };

  if (getCurrentScope()) onScopeDispose(() => generation++);

  return { data, loading, failed, hasMore, loadMore, retry, reset };
}
