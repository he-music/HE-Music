import { useSettingStore } from "@/stores";
import { SettingConfig } from "@/types/settings";
import { computed } from "vue";
import { t } from "@/i18n";
import { platform } from "@/platform";
import { useMygoNetworkProxySettings } from "./networkProxy";

export const useNetworkSettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  const integration: SettingConfig["groups"][number] = {
    title: t("setting.network.third_party_integration"),
    items: [
      {
        key: "smtcOpen",
        label: t("setting.play.smtc"),
        type: "switch",
        description: t("setting.play.smtc_tip"),
        value: computed({
          get: () => settingStore.smtcOpen,
          set: (value) => (settingStore.smtcOpen = value),
        }),
      },
    ],
  };
  if (platform.kind === "mygo" && platform.networkProxy) {
    const proxy = useMygoNetworkProxySettings(platform.networkProxy, settingStore);
    return {
      groups: [proxy.group, integration],
      onActivate: proxy.onActivate,
      onDeactivate: proxy.onDeactivate,
    };
  }
  return { groups: [integration] };
};
