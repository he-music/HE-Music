import { onScopeDispose, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useMobile } from "./useMobile";
import { getOverlayHistory } from "@/utils/overlayHistory";

/** 移动端临时界面共用返回栈；关闭、切换布局及卸载时自动释放。 */
export function useOverlayBack(visible: MaybeRefOrGetter<boolean>, close: () => void) {
  const { isMobilePlayer } = useMobile();
  let release: (() => void) | undefined;
  const stop = watch(
    () => isMobilePlayer.value && toValue(visible),
    (active) => {
      release?.();
      release = active ? getOverlayHistory().add(close) : undefined;
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    stop();
    release?.();
  });
}
