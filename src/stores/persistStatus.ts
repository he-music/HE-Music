import { watch } from "vue";
import type { PiniaPluginContext } from "pinia";
import type { StatusState } from "./status";

const persistedKeys = [
  "menuCollapsed",
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

/** status 的高频播放状态不参与持久化订阅，其余 store 仍使用原插件。 */
export function persistStatus({ store }: PiniaPluginContext) {
  if (store.$id !== "status") return;
  const storage = localStorage;
  const key = "status-store";

  store.$persist = () => {
    try {
      const snapshot = Object.fromEntries(
        persistedKeys.map((field) => [field, store.$state[field]]),
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
          persistedKeys
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
  watch(
    () => persistedKeys.map((field) => store.$state[field]),
    () => store.$persist(),
    // 仅遍历选定字段的嵌套数据；watch 随 Pinia store 的作用域一同释放。
    { deep: true },
  );
}
