import { computed, watch } from "vue";
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

/** status 按字段持久化，播放进度仅在秒数变化时触发保存，其余 store 仍使用原插件。 */
export function persistStatus({ store, pinia }: PiniaPluginContext) {
  if (store.$id !== "status") return;
  const storage = localStorage;
  const key = "status-store";

  const settingStore = useSettingStore(pinia);
  // 关闭记忆位置后移除进度字段，同时停止依赖高频进度；切换开关会更新快照。
  const activeKeys = computed(() =>
    settingStore.memoryLastSeek
      ? persistedKeys
      : persistedKeys.filter((field) => field !== "currentTime"),
  );

  store.$persist = () => {
    try {
      const snapshot = Object.fromEntries(
        activeKeys.value.map((field) => [field, store.$state[field]]),
      );
      storage.setItem(key, JSON.stringify(snapshot));
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
  // 保持运行时和快照的毫秒精度，仅将监听粒度降为秒；同一秒内 computed 值不变。
  const currentTimeSeconds = computed(() => Math.floor(store.$state.currentTime / 1000));
  watch(
    () =>
      activeKeys.value.map((field) =>
        field === "currentTime" ? currentTimeSeconds.value : store.$state[field],
      ),
    () => store.$persist(),
    // 仅遍历选定字段的嵌套数据；watch 随 Pinia store 的作用域一同释放。
    { deep: true },
  );
}
