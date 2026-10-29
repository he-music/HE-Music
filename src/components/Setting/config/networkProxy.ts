import { computed, shallowRef } from "vue";
import { t } from "@/i18n";
import type { SettingGroup } from "@/types/settings";
import {
  createNetworkProxySession,
  type NetworkProxyConfig,
  type NetworkProxyReceipt,
  type NetworkProxyState,
  type PlatformNetworkProxy,
} from "@/platform/networkProxy";

export interface NetworkProxySettingsStore {
  proxyProtocol: "off" | "http" | "https";
  proxyServe: string;
  proxyPort: number;
}

export function networkProxyReceiptMessage(receipt: NetworkProxyReceipt): string {
  if (!receipt.saved) return "mygo.proxy.save_failed";
  if (receipt.restartRequired) return "mygo.proxy.restart";
  if (!receipt.webviewApplied) return "mygo.proxy.unsupported";
  if (!receipt.downloadsApplied) return "mygo.proxy.partial";
  return "mygo.proxy.applied";
}

// Construction is inert during settings search. The panel forwards both hooks.
export function useMygoNetworkProxySettings(
  provider: PlatformNetworkProxy,
  store: NetworkProxySettingsStore,
) {
  let actionGeneration = 0;
  const state = shallowRef<NetworkProxyState>();
  const session = createNetworkProxySession(provider, (next) => {
    state.value = next;
  });
  state.value = session.state();
  const draft = computed(() => state.value?.draft ?? { protocol: "off", server: "", port: 0 });
  const update = (patch: Partial<NetworkProxyConfig>) => {
    actionGeneration++;
    session.edit({ ...draft.value, ...patch });
  };
  const protocol = computed({
    get: () => draft.value.protocol,
    set: (value: string) => update({ protocol: value }),
  });
  const server = computed({
    get: () => draft.value.server,
    set: (value: string) => update({ server: value }),
  });
  const port = computed({
    get: () => draft.value.port,
    set: (value: number | null) => update({ port: value ?? 0 }),
  });
  const disabled = computed(
    () =>
      !state.value?.active ||
      !!state.value?.loading ||
      !!state.value?.applying ||
      !!state.value?.testing,
  );
  const fieldDisabled = computed(() => disabled.value || draft.value.protocol === "off");
  const description = computed(() => {
    const receipt = state.value?.receipt;
    if (!receipt) return t("mygo.proxy.scope");
    return [
      t("mygo.proxy.scope"),
      t(receipt.webviewApplied ? "mygo.proxy.web_applied" : "mygo.proxy.web_unapplied"),
      t(
        receipt.downloadsApplied
          ? "mygo.proxy.downloads_applied"
          : "mygo.proxy.downloads_unapplied",
      ),
    ].join(" ");
  });
  const showError = () => {
    const error = state.value?.error;
    if (error)
      window.$message.error(
        t(
          error === "invalid-proxy"
            ? "mygo.proxy.invalid"
            : error === "load-failed"
              ? "mygo.proxy.load_failed"
              : error === "test-failed"
                ? "message.proxy_test_fail"
                : "mygo.proxy.save_failed",
        ),
      );
  };
  const save = async () => {
    if (disabled.value) return;
    const generation = actionGeneration;
    await session.apply();
    const current = state.value;
    if (!current?.active || generation !== actionGeneration) return;
    showError();
    const receipt = current.receipt;
    if (!receipt?.saved) return;
    const config = current.draft;
    if (config.protocol !== "off" && config.protocol !== "HTTP" && config.protocol !== "HTTPS")
      return;
    store.proxyProtocol =
      config.protocol === "HTTP" ? "http" : config.protocol === "HTTPS" ? "https" : "off";
    if (config.protocol !== "off") {
      store.proxyServe = config.server;
      store.proxyPort = config.port;
    }
    const message = t(networkProxyReceiptMessage(receipt));
    if (receipt.webviewApplied && receipt.downloadsApplied && !receipt.restartRequired)
      window.$message.success(message);
    else window.$message.warning(message);
  };
  const test = async () => {
    if (disabled.value) return;
    const generation = actionGeneration;
    await session.test();
    const current = state.value;
    if (!current?.active || generation !== actionGeneration) return;
    showError();
    if (!current.testResult) return;
    if (current.testResult.reachable) window.$message.success(t("message.proxy_test_success"));
    else window.$message.error(t("message.proxy_test_fail"));
  };
  const group: SettingGroup = {
    title: t("setting.other.network_proxy"),
    items: [
      {
        key: "proxyProtocol",
        label: t("setting.other.network_proxy"),
        type: "select",
        description,
        value: protocol,
        disabled,
        options: [
          { label: t("common.close"), value: "off" },
          { label: "HTTP", value: "HTTP" },
          { label: "HTTPS", value: "HTTPS" },
        ],
        extraButton: {
          label: t("common.save_and_apply"),
          action: save,
          type: "primary",
          secondary: true,
          strong: true,
        },
      },
      {
        key: "proxyServe",
        label: t("setting.other.proxy_server"),
        type: "text-input",
        description: t("setting.other.proxy_server_tip"),
        value: server,
        disabled: fieldDisabled,
        componentProps: { placeholder: t("setting.other.proxy_server_placeholder") },
      },
      {
        key: "proxyPort",
        label: t("setting.other.proxy_port"),
        type: "input-number",
        description: t("setting.other.proxy_port_tip"),
        value: port,
        disabled: fieldDisabled,
        componentProps: {
          min: 1,
          max: 65535,
          showButton: false,
          placeholder: t("setting.other.proxy_port_placeholder"),
        },
      },
      {
        key: "proxyTest",
        label: t("setting.other.proxy_test"),
        type: "button",
        description: t("mygo.proxy.scope"),
        buttonLabel: t("setting.other.proxy_test"),
        action: test,
        condition: () => draft.value.protocol !== "off",
        disabled,
        componentProps: computed(() => ({
          loading: state.value?.testing ?? false,
          type: "primary",
        })),
      },
    ],
  };
  return {
    group,
    onActivate: async () => {
      const generation = ++actionGeneration;
      await session.activate();
      if (state.value?.active && generation === actionGeneration) showError();
    },
    onDeactivate: () => {
      actionGeneration++;
      session.deactivate();
    },
  };
}
