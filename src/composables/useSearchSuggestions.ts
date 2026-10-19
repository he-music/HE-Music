import { ref, toValue, watch, type MaybeRefOrGetter } from "vue";

/** 输入变化时立即使旧结果失效，防抖只延迟新请求的发送。 */
export function useSearchSuggestions(
  keyword: MaybeRefOrGetter<string>,
  platform: MaybeRefOrGetter<string | undefined>,
  fetchSuggestions: (keyword: string, platform: string) => Promise<{ keys: string[] }>,
) {
  const suggestions = ref<string[]>([]);

  watch(
    [() => toValue(keyword).trim(), () => toValue(platform)],
    ([value, platformId], _, onCleanup) => {
      suggestions.value = [];
      if (!value || !platformId) return;

      let active = true;
      const timer = setTimeout(async () => {
        try {
          const result = await fetchSuggestions(value, platformId);
          if (active) suggestions.value = result.keys;
        } catch (error) {
          if (active) console.error("获取搜索建议失败：", error);
        }
      }, 300);
      onCleanup(() => {
        active = false;
        clearTimeout(timer);
      });
    },
    { immediate: true, flush: "sync" },
  );

  return suggestions;
}
