import { useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { SettingConfig } from "@/types/settings";
import { computed, ref } from "vue";
import { debounce } from "lodash-es";
import { t } from "@/i18n";

export const useNetworkSettings = (): SettingConfig => {
  const settingStore = useSettingStore();
  const testProxyLoading = ref<boolean>(false);

  // --- Network Proxy Logic (from other.ts) ---
  const proxyConfig = computed(() => ({
    protocol: settingStore.proxyProtocol,
    server: settingStore.proxyServe,
    port: settingStore.proxyPort,
  }));

  // 应用代理
  const setProxy = debounce(() => {
    if (
      settingStore.proxyProtocol === "off" ||
      !settingStore.proxyServe ||
      !settingStore.proxyPort
    ) {
      window.electron.ipcRenderer.send("remove-proxy");
      window.$message.success(t("message.proxy_close_success"));
      return;
    }
    window.electron.ipcRenderer.send("set-proxy", proxyConfig.value);
    window.$message.success(t("message.proxy_set_success"));
  }, 300);

  // 测试代理
  const testProxy = async () => {
    testProxyLoading.value = true;
    const result = await window.electron.ipcRenderer.invoke("test-proxy", proxyConfig.value);
    if (result) {
      window.$message.success(t("message.proxy_test_success"));
    } else {
      window.$message.error(t("message.proxy_test_fail"));
    }
    testProxyLoading.value = false;
  };

  return {
    groups: [
      {
        title: t("setting.other.network_proxy"),
        items: [
          {
            key: "proxyProtocol",
            label: t("setting.other.network_proxy"),
            show: isElectron,
            type: "select",
            description: t("setting.other.proxy_tip"),
            options: [
              {
                label: t("common.close"),
                value: "off",
              },
              {
                label: "HTTP",
                value: "HTTP",
              },
              {
                label: "HTTPS",
                value: "HTTPS",
              },
            ],
            value: computed({
              get: () => settingStore.proxyProtocol,
              set: (v) => (settingStore.proxyProtocol = v),
            }),
            extraButton: {
              label: t("common.save_and_apply"),
              action: setProxy,
              type: "primary",
              secondary: true,
              strong: true,
            },
          },
          {
            key: "proxyServe",
            label: t("setting.other.proxy_server"),
            show: isElectron,
            type: "text-input",
            description: t("setting.other.proxy_server_tip"),
            disabled: computed(() => settingStore.proxyProtocol === "off"),
            prefix: computed(() =>
              settingStore.proxyProtocol === "off" ? "-" : settingStore.proxyProtocol,
            ),
            componentProps: {
              placeholder: t("setting.other.proxy_server_placeholder"),
            },
            value: computed({
              get: () => settingStore.proxyServe,
              set: (v) => (settingStore.proxyServe = v),
            }),
          },
          {
            key: "proxyPort",
            label: t("setting.other.proxy_port"),
            show: isElectron,
            type: "input-number",
            description: t("setting.other.proxy_port_tip"),
            disabled: computed(() => settingStore.proxyProtocol === "off"),
            componentProps: {
              min: 1,
              max: 65535,
              showButton: false,
              placeholder: t("setting.other.proxy_port_placeholder"),
            },
            value: computed({
              get: () => settingStore.proxyPort,
              set: (v) => (settingStore.proxyPort = v),
            }),
          },
          {
            key: "proxyTest",
            label: t("setting.other.proxy_test"),
            show: isElectron,
            type: "button",
            description: t("setting.other.proxy_test_tip"),
            buttonLabel: t("setting.other.proxy_test"),
            action: testProxy,
            condition: () => settingStore.proxyProtocol !== "off",
            componentProps: computed(() => ({
              loading: testProxyLoading.value,
              type: "primary",
            })),
          },
        ],
      },
      {
        title: t("setting.network.third_party_integration"),
        items: [
          {
            key: "smtcOpen",
            label: t("setting.play.smtc"),
            type: "switch",
            description: t("setting.play.smtc_tip"),
            value: computed({
              get: () => settingStore.smtcOpen,
              set: (v) => (settingStore.smtcOpen = v),
            }),
          },
        ],
      },
    ],
  };
};
