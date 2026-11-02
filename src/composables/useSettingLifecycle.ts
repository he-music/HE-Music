import {
  computed,
  effectScope,
  getCurrentInstance,
  onActivated,
  onDeactivated,
  onScopeDispose,
  watch,
  type Ref,
} from "vue";
import type { SettingConfig } from "@/types/settings";

/** Own effects created by lazy search/render evaluation, including locale replacements. */
export function useScopedSettingConfig(create: () => SettingConfig) {
  let scope: ReturnType<typeof effectScope> | undefined;
  let disposed = false;
  let last: SettingConfig = { groups: [] };
  onScopeDispose(() => {
    disposed = true;
    scope?.stop();
  });
  return computed(() => {
    if (disposed) return last;
    scope?.stop();
    scope = effectScope(true);
    scope.run(() => {
      const config = create();
      let active = false;
      const deactivate = () => {
        if (!active) return;
        active = false;
        config.onDeactivate?.();
      };
      onScopeDispose(deactivate);
      last = {
        ...config,
        onActivate: () => {
          if (active) return;
          active = true;
          return config.onActivate?.();
        },
        onDeactivate: deactivate,
      };
    });
    return last;
  });
}

/** Only the selected, visible configuration may perform activation work. */
export function useSettingActivation(selected: Readonly<Ref<SettingConfig | undefined>>) {
  let visible = true;
  let current: SettingConfig | undefined;
  const deactivate = () => {
    current?.onDeactivate?.();
    current = undefined;
  };
  const activate = () => {
    const next = visible ? selected.value : undefined;
    if (next === current) return;
    deactivate();
    current = next;
    if (next) {
      void Promise.resolve(next.onActivate?.()).catch((error: unknown) => {
        console.error("设置初始化失败", error);
      });
    }
  };
  watch(selected, activate, { immediate: true });
  onScopeDispose(() => {
    visible = false;
    deactivate();
  });
  if (getCurrentInstance()) {
    onDeactivated(() => {
      visible = false;
      deactivate();
    });
    onActivated(() => {
      visible = true;
      activate();
    });
  }
}
