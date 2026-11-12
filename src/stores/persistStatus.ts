import {
  applicationStorage,
  registerApplicationWriteCheckpoint,
} from "@/platform/applicationStorage";
import { computed, onScopeDispose, watch } from "vue";
import type { PiniaPluginContext } from "pinia";
import type { StatusState } from "./status";
import { useSettingStore } from "./setting";

const persistedKeys = [
  "menuCollapsed",
  "currentTime",
  "duration",
  "currentTimeOffsetMap",
  "pureLyricMode",
  "playIndex",
  "playRate",
  "playVolume",
  "playVolumeMute",
  "playSongMode",
  "songCoverTheme",
  "listSortField",
  "listSortOrder",
  "showDesktopLyric",
  "playQuality",
  "selectedQuality",
  "radioMode",
  "eqEnabled",
  "eqBands",
  "eqPreset",
  "themeBackgroundMode",
  "backgroundConfig",
  "commentConfig",
] as const satisfies readonly (keyof StatusState)[];

/** 设置按字段保存，连续播放位置每十秒保存；暂停、跳转及退出时保存最新位置。 */
export function persistStatus({ store, pinia }: PiniaPluginContext) {
  if (store.$id !== "status") return;
  const storage = applicationStorage;
  const key = "status-store";

  const settingStore = useSettingStore(pinia);
  // 关闭记忆位置后移除进度字段，同时停止依赖高频进度；切换开关会更新快照。
  const activeKeys = computed(() =>
    settingStore.memoryLastSeek
      ? persistedKeys
      : persistedKeys.filter((field) => field !== "currentTime"),
  );

  let savedTime: number;
  store.$persist = () => {
    try {
      const snapshot = Object.fromEntries(
        activeKeys.value.map((field) => [field, store.$state[field]]),
      );
      storage.setItem(key, JSON.stringify(snapshot));
      savedTime = store.$state.currentTime;
    } catch (error) {
      console.warn("保存播放器设置失败", error);
    }
  };

  store.$hydrate = () => {
    try {
      const saved = storage.getItem(key);
      if (!saved) return;
      const snapshot = JSON.parse(saved);
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
      // 旧版“默认方向”表示不排序，迁移到默认字段并保留原始列表顺序。
      if (snapshot.listSortOrder === "default") {
        snapshot.listSortField = "default";
        snapshot.listSortOrder = "asc";
      }
      store.$patch(
        Object.fromEntries(
          activeKeys.value
            .filter((field) => Object.hasOwn(snapshot, field))
            .map((field) => [field, snapshot[field]]),
        ),
      );
    } catch (error) {
      console.warn("恢复播放器设置失败", error);
    }
  };

  // 沿用原存储键与字段，恢复已有设置后才开始监听，避免初始化时覆盖旧数据。
  store.$hydrate();
  savedTime = store.$state.currentTime;
  watch(
    () =>
      persistedKeys.filter((field) => field !== "currentTime").map((field) => store.$state[field]),
    () => store.$persist(),
    { deep: true },
  );
  // 记忆开关本身不属于 status；变化时仍需移除或恢复快照中的位置。
  watch(
    () => settingStore.memoryLastSeek,
    () => store.$persist(),
  );
  const checkpoint = () => {
    if (settingStore.memoryLastSeek && store.$state.currentTime !== savedTime) store.$persist();
  };
  const positionCheckpoint = computed(() =>
    settingStore.memoryLastSeek ? Math.floor(store.$state.currentTime / 10_000) : 0,
  );
  watch(positionCheckpoint, checkpoint);
  watch(
    () => store.$state.playStatus,
    (playing, wasPlaying) => {
      if (!playing && wasPlaying) checkpoint();
    },
  );
  const stopCheckpoint = registerApplicationWriteCheckpoint(checkpoint);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") checkpoint();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", checkpoint);
    onScopeDispose(() => window.removeEventListener("pagehide", checkpoint));
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibility);
    onScopeDispose(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  onScopeDispose(stopCheckpoint);
}
