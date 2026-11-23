import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { usePlatformStore } from "@/stores/platform";
import type { TabInfo } from "@/types/main.hemusic";
import { useAsyncRequest } from "./useAsyncRequest";

export type ReleaseRouteName = "new-song" | "new-album";

export function usePlatformTabs(
  routeName: ReleaseRouteName,
  requiredFlags: bigint,
  fetchTabs: (platform: string) => Promise<{ list: TabInfo[] }>,
) {
  const router = useRouter();
  const route = useRoute();
  const platformStore = usePlatformStore();
  const platforms = computed(() =>
    platformStore.platforms.filter(
      (item) => item.status === 1 && (item.feature_support_flag & requiredFlags) === requiredFlags,
    ),
  );
  const platform = computed(() => {
    if (route.name !== routeName) return undefined;
    return (platforms.value.find((item) => item.id === route.query.platform) ?? platforms.value[0])
      ?.id;
  });

  const {
    data: tabs,
    loading,
    failed,
    retry,
    reset,
  } = useAsyncRequest(async () => {
    const id = platform.value;
    if (!id) return [];
    const result = await fetchTabs(id);
    return result.list;
  });
  const tabId = computed(
    () => tabs.value?.find((tab) => tab.id === route.query.tab_id)?.id ?? tabs.value?.[0]?.id,
  );

  const platformChange = (id: string) => {
    if (id === platform.value || !platforms.value.some((item) => item.id === id)) return;
    void router.replace({ name: routeName, query: { platform: id } });
  };
  const tagChange = (id: string) => {
    if (id === tabId.value || !platform.value || !tabs.value?.some((tab) => tab.id === id)) return;
    void router.replace({ name: routeName, query: { platform: platform.value, tab_id: id } });
  };

  watch(platform, () => void reset(), { immediate: true });
  watch(
    [platform, () => route.query.platform],
    ([id, requested]) => {
      if (id && id !== requested) void router.replace({ name: routeName, query: { platform: id } });
    },
    { immediate: true },
  );

  return {
    platforms,
    platform,
    platformLoading: computed(() => platformStore.loading),
    platformChange,
    tabId,
    tabs,
    loading,
    failed,
    retry,
    tagChange,
  };
}
