import { describe, expect, it, vi } from "vitest";
import { isRef, toValue } from "vue";
import type { NetworkProxySettingsStore } from "./networkProxy";
import { networkProxyReceiptMessage, useMygoNetworkProxySettings } from "./networkProxy";
import type {
  NetworkProxyConfig,
  NetworkProxyReceipt,
  PlatformNetworkProxy,
} from "@/platform/networkProxy";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

const config: NetworkProxyConfig = { protocol: "HTTP", server: "proxy.invalid", port: 8080 };
const partial: NetworkProxyReceipt = {
  saved: true,
  webviewApplied: false,
  downloadsApplied: true,
  restartRequired: false,
  errorCode: "webview-unsupported",
};
function setup() {
  const store: NetworkProxySettingsStore = {
    proxyProtocol: "off",
    proxyServe: "localhost",
    proxyPort: 80,
  };
  const provider: PlatformNetworkProxy = {
    current: vi.fn(async () => config),
    apply: vi.fn(async () => partial),
    test: vi.fn(async () => ({ reachable: true, scope: "go-http-test-only" })),
  };
  const messages = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
  vi.stubGlobal("window", { $message: messages });
  return { store, provider, messages, settings: useMygoNetworkProxySettings(provider, store) };
}
function pendingReceipt() {
  let complete: (receipt: NetworkProxyReceipt) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<NetworkProxyReceipt>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
}

describe("mygo network settings", () => {
  it("does not call providers or mutate stored settings during search construction", () => {
    const { settings, provider, store } = setup();
    expect(provider.current).not.toHaveBeenCalled();
    expect(provider.apply).not.toHaveBeenCalled();
    expect(store.proxyProtocol).toBe("off");
    expect(settings.group.items).toHaveLength(4);
  });

  it("loads on activation, saves only confirmed configs, and warns about unsupported webview", async () => {
    const { settings, provider, store, messages } = setup();
    await settings.onActivate();
    expect(store.proxyProtocol).toBe("off");
    const server = settings.group.items.find((item) => item.key === "proxyServe");
    if (!server?.value || !isRef(server.value)) throw new Error("missing server input");
    server.value.value = "changed.invalid";
    expect(store.proxyServe).toBe("localhost");
    await settings.group.items[0].extraButton?.action();
    expect(provider.apply).toHaveBeenCalledWith({ ...config, server: "changed.invalid" });
    expect(store.proxyServe).toBe("changed.invalid");
    expect(store.proxyProtocol).toBe("http");
    expect(messages.warning).toHaveBeenCalledWith("mygo.proxy.unsupported");
    expect(messages.success).not.toHaveBeenCalled();
    expect(toValue(settings.group.items[0].description)).toContain(
      "mygo.proxy.web_unapplied mygo.proxy.downloads_applied",
    );
  });

  it("keeps failed and late saves out of the store", async () => {
    const { settings, provider, store, messages } = setup();
    await settings.onActivate();
    provider.apply = vi.fn(async () => {
      throw new Error("storage failed");
    });
    await settings.group.items[0].extraButton?.action();
    expect(store.proxyProtocol).toBe("off");
    expect(messages.error).toHaveBeenCalledWith("mygo.proxy.save_failed");
    messages.error.mockClear();
    const pending = pendingReceipt();
    provider.apply = vi.fn(() => pending.promise);
    const saving = settings.group.items[0].extraButton?.action();
    settings.onDeactivate();
    pending.complete(partial);
    await saving;
    expect(store.proxyProtocol).toBe("off");
    expect(messages.warning).not.toHaveBeenCalled();
    expect(messages.error).not.toHaveBeenCalled();
  });

  it("rejects old helper callbacks after a replacement activation and save", async () => {
    const { settings, provider, store, messages } = setup();
    await settings.onActivate();
    const pending = pendingReceipt();
    provider.apply = vi.fn(() => pending.promise);
    const old = settings.group.items[0].extraButton?.action();
    settings.onDeactivate();
    await settings.onActivate();
    provider.apply = vi.fn(async () => partial);
    await settings.group.items[0].extraButton?.action();
    expect(messages.warning).toHaveBeenCalledTimes(1);
    store.proxyServe = "store-current.invalid";
    pending.complete(partial);
    await old;
    expect(store.proxyServe).toBe("store-current.invalid");
    expect(messages.warning).toHaveBeenCalledTimes(1);
  });

  it("describes test scope and does not apply or save when testing", async () => {
    const { settings, provider, store } = setup();
    await settings.onActivate();
    const test = settings.group.items.find((item) => item.key === "proxyTest");
    expect(toValue(test?.description)).toBe("mygo.proxy.scope");
    await test?.action?.();
    expect(provider.test).toHaveBeenCalledWith(config);
    expect(provider.apply).not.toHaveBeenCalled();
    expect(store.proxyProtocol).toBe("off");
  });

  it("distinguishes restart and partial scope receipts", () => {
    expect(networkProxyReceiptMessage({ ...partial, restartRequired: true })).toBe(
      "mygo.proxy.restart",
    );
    expect(
      networkProxyReceiptMessage({ ...partial, webviewApplied: true, downloadsApplied: false }),
    ).toBe("mygo.proxy.partial");
    expect(networkProxyReceiptMessage({ ...partial, webviewApplied: true })).toBe(
      "mygo.proxy.applied",
    );
    expect(networkProxyReceiptMessage({ ...partial, saved: false })).toBe("mygo.proxy.save_failed");
  });
});
