import { getCurrentScope, onScopeDispose, ref, shallowRef } from "vue";

/** A resource can be retried independently without clearing successful content. */
export function useAsyncRequest<T>(fetchData: () => Promise<T>) {
  const data = shallowRef<T | null>(null);
  const loading = ref(true);
  const failed = ref(false);
  let generation = 0;
  let pending = false;

  const retry = async () => {
    if (pending) return;
    const currentGeneration = generation;
    pending = true;
    loading.value = true;
    failed.value = false;
    try {
      const result = await fetchData();
      if (currentGeneration === generation) data.value = result;
    } catch {
      if (currentGeneration === generation) failed.value = true;
    } finally {
      if (currentGeneration === generation) {
        loading.value = false;
        pending = false;
      }
    }
  };

  const reset = () => {
    generation++;
    pending = false;
    data.value = null;
    return retry();
  };

  if (getCurrentScope()) onScopeDispose(() => generation++);
  return { data, loading, failed, retry, reset };
}
