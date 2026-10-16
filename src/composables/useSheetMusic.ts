import { computed, watch, type Ref } from "vue";
import { getSheetMusic, isSheetMusicNotImplemented, listSongSheetMusic } from "@/api/sheetMusic";
import { useAsyncRequest } from "./useAsyncRequest";

type SheetMusicResult<T> = { kind: "ready"; value: T } | { kind: "not-implemented" };

async function loadSheetMusic<T>(fetchData: () => Promise<T>): Promise<SheetMusicResult<T>> {
  try {
    return { kind: "ready", value: await fetchData() };
  } catch (error) {
    if (isSheetMusicNotImplemented(error)) return { kind: "not-implemented" };
    throw error;
  }
}

/** 路由参数或功能位变化时失效旧请求，离开页面后不接受在途响应。 */
function useSheetMusicRequest<T>(
  fetchData: () => Promise<T>,
  sources: Ref<string>[],
  enabled: Ref<boolean>,
) {
  const request = useAsyncRequest(() =>
    enabled.value ? loadSheetMusic(fetchData) : Promise.resolve(null),
  );
  watch([enabled, ...sources], () => void request.reset(), { immediate: true });
  const notImplemented = computed(() => request.data.value?.kind === "not-implemented");
  return { ...request, retry: request.reset, notImplemented };
}

export function useSheetMusicList(
  platform: Ref<string>,
  songId: Ref<string>,
  enabled: Ref<boolean>,
) {
  const request = useSheetMusicRequest(
    async () => (await listSongSheetMusic(platform.value, songId.value)).list ?? [],
    [platform, songId],
    enabled,
  );
  const sheets = computed(() =>
    request.data.value?.kind === "ready" ? request.data.value.value : [],
  );
  return { ...request, sheets };
}

export function useSheetMusicDetail(
  platform: Ref<string>,
  songId: Ref<string>,
  id: Ref<string>,
  enabled: Ref<boolean>,
) {
  const request = useSheetMusicRequest(
    () => getSheetMusic(platform.value, id.value, songId.value),
    [platform, songId, id],
    enabled,
  );
  const info = computed(() =>
    request.data.value?.kind === "ready" ? request.data.value.value : null,
  );
  // 仅使用详情返回的页面，保留原始顺序，不从封面或页数推导图片地址。
  const pages = computed(() => (info.value?.page_urls ?? []).filter((url) => !!url?.trim()));
  return { ...request, info, pages };
}
