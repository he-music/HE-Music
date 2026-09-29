import { ref, watch, onScopeDispose, type Ref } from "vue";
import type { MVInfo } from "@/types/main.hemusic";

type FeedPage = { list: MVInfo[]; has_more: boolean };

export function useVideoFeed(
  supported: Ref<boolean>,
  video: Ref<MVInfo | null>,
  fetchPage: (id: string, platform: string, page: number) => Promise<FeedPage>,
) {
  const items = ref<MVInfo[]>([]);
  const loading = ref(false);
  const failed = ref(false);
  const hasMore = ref(false);
  let seed: MVInfo | null = null;
  let page = 1;
  let generation = 0;

  const reset = () => {
    generation++;
    seed = null;
    page = 1;
    items.value = [];
    loading.value = false;
    failed.value = false;
    hasMore.value = false;
  };

  const loadMore = async () => {
    if (!supported.value || !seed || loading.value || (page > 1 && !hasMore.value)) return;
    const currentGeneration = generation;
    loading.value = true;
    failed.value = false;
    try {
      const result = await fetchPage(seed.id, seed.platform, page);
      if (currentGeneration !== generation) return;
      const seen = new Set(items.value.map((item) => `${item.platform}:${item.id}`));
      const additions = result.list.filter((item) => {
        const key = `${item.platform}:${item.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      items.value = [...items.value, ...additions];
      hasMore.value = result.has_more;
      page++;
    } catch {
      if (currentGeneration === generation) failed.value = true;
    } finally {
      if (currentGeneration === generation) loading.value = false;
    }
  };

  watch(
    [supported, video],
    ([enabled, current]) => {
      if (!enabled) {
        reset();
        return;
      }
      if (!current) return;
      if (
        items.value.some((item) => item.id === current.id && item.platform === current.platform)
      ) {
        return;
      }
      reset();
      seed = current;
      items.value = [current];
      void loadMore();
    },
    { immediate: true },
  );

  onScopeDispose(reset);
  return { items, loading, failed, hasMore, loadMore };
}
