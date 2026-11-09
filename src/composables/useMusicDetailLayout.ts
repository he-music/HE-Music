import type { ComponentPublicInstance } from "vue";
import { useMobile } from "@/composables/useMobile";

/** 移动端详情页共用外层滚动区；位置由页面保存，不随异步头部的重建丢失。 */
export const useMusicDetailLayout = () => {
  const { isSmallScreen } = useMobile();
  const detailPageRef = shallowRef<HTMLElement | ComponentPublicInstance | null>(null);
  const pageElement = computed(() => {
    const page = detailPageRef.value;
    const element = page instanceof HTMLElement ? page : page?.$el;
    return element instanceof HTMLElement ? element : null;
  });
  const bindDetailPage = (element: Element | ComponentPublicInstance | null) => {
    if (element instanceof Element) {
      detailPageRef.value = element instanceof HTMLElement ? element : null;
    } else {
      detailPageRef.value = element;
    }
  };
  const scrollParent = shallowRef<HTMLElement | null>(null);
  let active = false;
  let savedTop = 0;
  let pendingTop: number | undefined;
  let settleFrame: number | undefined;

  const cancelRestore = () => {
    pendingTop = undefined;
    if (settleFrame !== undefined) cancelAnimationFrame(settleFrame);
    settleFrame = undefined;
  };
  const restorePosition = () => {
    const parent = scrollParent.value;
    if (!active || !isSmallScreen.value || !parent || pendingTop === undefined) return;
    // 等异步歌曲和虚拟列表的占位高度恢复后再滚动，避免被骨架屏的高度截断。
    if (parent.scrollHeight - parent.clientHeight < pendingTop) return;
    parent.scrollTop = pendingTop;
    if (pendingTop === 0) {
      cancelRestore();
      return;
    }
    if (settleFrame !== undefined) cancelAnimationFrame(settleFrame);
    // 吸顶标题出现会改变头部高度，待布局和浏览器滚动锚定结束后对齐保存的位置。
    settleFrame = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => {
        if (active && pendingTop !== undefined) parent.scrollTop = pendingTop;
        cancelRestore();
      });
    });
  };
  const bindScrollParent = () => {
    let parent = pageElement.value?.parentElement ?? null;
    while (parent && !/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) {
      parent = parent.parentElement;
    }
    scrollParent.value = parent;
  };
  const activate = async () => {
    active = true;
    if (!isSmallScreen.value) return;
    pendingTop = savedTop;
    await nextTick();
    if (!active) return;
    bindScrollParent();
    restorePosition();
  };

  useResizeObserver(pageElement, restorePosition);
  // 用户开始操作时，以其滚动为准，不再等待旧位置恢复。
  useEventListener(scrollParent, "wheel", cancelRestore, { passive: true });
  useEventListener(scrollParent, "touchstart", cancelRestore, { passive: true });
  useEventListener(scrollParent, "pointerdown", cancelRestore, { passive: true });
  onMounted(activate);
  onActivated(activate);
  onBeforeRouteLeave(() => {
    if (active && isSmallScreen.value) savedTop = scrollParent.value?.scrollTop ?? 0;
  });
  onBeforeRouteUpdate((to, from) => {
    if (
      to.query.id !== from.query.id ||
      to.query.target_id !== from.query.target_id ||
      to.query.platform !== from.query.platform
    ) {
      savedTop = 0;
      if (isSmallScreen.value) {
        cancelRestore();
        pendingTop = 0;
        nextTick(restorePosition);
      }
    }
  });
  onDeactivated(() => {
    active = false;
    cancelRestore();
  });
  onBeforeUnmount(() => {
    active = false;
    cancelRestore();
  });
  return { isSmallScreen, detailPageRef: bindDetailPage };
};
