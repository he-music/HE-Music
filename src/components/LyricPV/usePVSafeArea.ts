import { onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { resolvePVSafeArea, type PVSafeArea } from "./viewport";

// 只在布局、歌曲信息尺寸或窗口尺寸改变时测量，播放时间不参与布局依赖。
export function usePVSafeArea(root: Ref<HTMLElement | undefined>, enabled: () => boolean) {
  const area = shallowRef<PVSafeArea>();
  let observer: ResizeObserver | undefined;
  let mounted = false;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    frame = undefined;
    const element = root.value;
    if (!enabled() || !element) {
      area.value = undefined;
      return;
    }
    const player = element.closest(".full-player");
    const bounds = element.getBoundingClientRect();
    const info = player?.querySelector<HTMLElement>(".content-right > .player-data");
    const control = player?.querySelector<HTMLElement>(".player-control");
    const top = info ? info.getBoundingClientRect().bottom - bounds.top + 20 : 100;
    const bottom = control ? bounds.bottom - control.getBoundingClientRect().top + 24 : 104;
    const next = resolvePVSafeArea(bounds.height, top, bottom);
    if (next?.top !== area.value?.top || next?.bottom !== area.value?.bottom) area.value = next;
  };
  const schedule = () => {
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    timer = setTimeout(() => {
      timer = undefined;
      frame = requestAnimationFrame(measure);
    }, 120);
  };
  const observe = () => {
    if (!mounted) return;
    observer?.disconnect();
    clearTimeout(timer);
    timer = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    if (!enabled() || !root.value) {
      area.value = undefined;
      return;
    }
    const player = root.value.closest(".full-player");
    observer ??= new ResizeObserver(schedule);
    observer.observe(root.value);
    for (const element of player?.querySelectorAll(
      ".content-right > .player-data, .player-control",
    ) ?? [])
      observer.observe(element);
    measure();
  };
  onMounted(() => {
    mounted = true;
    observe();
  });
  watch(enabled, observe, { flush: "post" });
  onBeforeUnmount(() => {
    mounted = false;
    observer?.disconnect();
    clearTimeout(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  return area;
}
