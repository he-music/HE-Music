import { describe, expect, it, vi } from "vitest";
import {
  createNetworkProxyProvider,
  createNetworkProxySession,
  validateNetworkProxy,
  type NetworkProxyConfig,
  type NetworkProxyReceipt,
  type PlatformNetworkProxy,
} from "./networkProxy";

const off: NetworkProxyConfig = { protocol: "off", server: "", port: 0 };
const http: NetworkProxyConfig = { protocol: "HTTP", server: "proxy.invalid", port: 8080 };
const receipt: NetworkProxyReceipt = {
  saved: true,
  webviewApplied: false,
  downloadsApplied: true,
  restartRequired: false,
  errorCode: "webview-unsupported",
};
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(): PlatformNetworkProxy {
  return {
    current: vi.fn(async () => off),
    apply: vi.fn(async () => receipt),
    test: vi.fn(async () => ({ reachable: true, scope: "go-http-test-only" })),
  };
}

describe("networkProxy", () => {
  it("validates bare host and integer port without accepting credentials or switches", () => {
    for (const server of [
      "a..b",
      "user@host",
      "host/path",
      "-flag",
      "host --flag",
      "https://host",
      "[::1]",
      "host\n",
    ]) {
      expect(() => validateNetworkProxy({ ...http, server })).toThrow();
    }
    for (const server of ["localhost", "127.0.0.1", "::1", "proxy.example"])
      expect(validateNetworkProxy({ ...http, server }).server).toBe(server);
    expect(() => validateNetworkProxy({ ...http, port: 1.5 })).toThrow();
    expect(() => validateNetworkProxy({ ...http, port: 65536 })).toThrow();
    expect(validateNetworkProxy(off)).toEqual(off);
  });

  it("maps the exact typed bound provider without starting work", async () => {
    const bindings = provider();
    const api = createNetworkProxyProvider(bindings);
    expect(bindings.current).not.toHaveBeenCalled();
    expect(await api.current()).toEqual(off);
    await api.apply(http);
    expect(bindings.apply).toHaveBeenCalledWith(http);
  });

  it("does no work during construction and rejects responses after deactivation", async () => {
    const api = provider();
    const pending = deferred<NetworkProxyConfig>();
    api.current = vi.fn(() => pending.promise);
    const update = vi.fn();
    const session = createNetworkProxySession(api, update);
    expect(api.current).not.toHaveBeenCalled();
    const activation = session.activate();
    session.deactivate();
    update.mockClear();
    pending.resolve(http);
    await activation;
    expect(update).not.toHaveBeenCalled();
    expect(session.state().loading).toBe(false);
  });

  it("discards late tests and saves when the draft or owner changes", async () => {
    const api = provider();
    const pending = deferred<{ reachable: boolean; scope: string }>();
    const saving = deferred<NetworkProxyReceipt>();
    api.test = vi.fn(() => pending.promise);
    api.apply = vi.fn(() => saving.promise);
    const session = createNetworkProxySession(api, () => {});
    await session.activate();
    session.edit(http);
    const testing = session.test();
    session.edit({ ...http, port: 9090 });
    pending.resolve({ reachable: true, scope: "go-http-test-only" });
    await testing;
    expect(session.state().testResult).toBeNull();
    const applying = session.apply();
    session.deactivate();
    await session.activate();
    saving.resolve(receipt);
    await applying;
    expect(session.state().receipt).toBeNull();
    expect(session.state().draft).toEqual(off);
  });

  it("retains partial receipts and reports persistence/call failures", async () => {
    const api = provider();
    const session = createNetworkProxySession(api, () => {});
    await session.activate();
    session.edit(http);
    await session.apply();
    expect(session.state().receipt).toEqual(receipt);
    api.apply = vi.fn(async () => {
      throw new Error("disk full");
    });
    await session.apply();
    expect(session.state().receipt).toBeNull();
    expect(session.state().error).toBe("apply-failed");
  });
});
