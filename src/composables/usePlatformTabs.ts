import { ref, watch } from "vue";
import { onBeforeRouteUpdate, useRouter } from "vue-router";
import { usePlatformStore } from "@/stores/platform";
import type { TabInfo } from "@/types/main.hemusic";
import { useAsyncRequest } from "./useAsyncRequest";

export function usePlatformTabs(
  routeName: "new-song" | "new-album",
  fetchTabs: (platform: string) => Promise<{ list: TabInfo[] }>,
) {
  const router = useRouter();
  const platformStore = usePlatformStore();
  const tab_id = ref<string>(router.currentRoute.value.query?.tab_id as string);
  const platform = ref<string>(router.currentRoute.value.query?.platform as string);

  const tagChange = (tab_id: string) => {
    router.replace({ name: routeName, query: { tab_id, platform: platform.value } });
  };
  const {
    data: tabs,
    loading,
    failed,
    retry,
    reset: getTabList,
  } = useAsyncRequest<TabInfo[]>(async () => {
    const result = await fetchTabs(platform.value);
    return result.list;
  });
  watch(tabs, (items) => {
    if (!items?.some((item) => item.id === tab_id.value)) tab_id.value = items?.[0]?.id || "";
  });

  onBeforeRouteUpdate((to) => {
    if (to.name !== routeName) return;
    tab_id.value = to.query.tab_id as string;
  });

  watch(
    () => platformStore.platforms,
    (platforms) => {
      if (!platforms.length) return;
      if (!platforms.some((item) => item.id === platform.value)) {
        platform.value = platforms[0].id;
      }
      void getTabList();
    },
    { immediate: true },
  );

  return { tab_id, tabs, loading, failed, retry, tagChange };
}
