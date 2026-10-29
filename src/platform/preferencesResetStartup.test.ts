import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { createPinia, setActivePinia } from "pinia";
import persistedState from "pinia-plugin-persistedstate";
import {
  recoverPreferencesResetBeforeMount,
  type PreferencesResetTransaction,
} from "./preferencesResetStartup";
import { executePreferencesReset, type PreferencesResetMode } from "./preferencesReset";

const backend = vi.hoisted(() => ({
  stores: new Map<string, unknown>(),
  drop: vi.fn<(options: { name: string; storeName: string }) => Promise<void>>(),
}));
vi.mock("localforage", () => ({
  default: {
    dropInstance: (options: { name: string; storeName: string }) => backend.drop(options),
  },
}));
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => {
    values.clear();
  },
};
vi.stubGlobal("localStorage", storage);
const session = { clear: vi.fn() };
beforeEach(() => {
  values.clear();
  backend.stores.clear();
  vi.clearAllMocks();
  values.set(
    "setting-store",
    JSON.stringify({ themeCustomColor: "#abcdef", registryProtocols: ["kuwo"] }),
  );
  values.set("shortcut-store", "preserved shortcut fixture");
  values.set("account", "preserved account fixture");
  backend.stores.set("local-data/local_download_history", ["history"]);
  backend.stores.set("local-data/local", ["cached song"]);
  backend.stores.set("background-data/background", "cached blob");
  backend.stores.set("music-data/music", ["playback history"]);
  backend.stores.set("user-data/user", ["user data"]);
  backend.stores.set("unrelated/store", "untouched");
  backend.drop.mockImplementation(async ({ name, storeName }) => {
    backend.stores.delete(`${name}/${storeName}`);
  });
});
afterEach(() => {
  vi.clearAllMocks();
});
function durableNative(mode: PreferencesResetMode, phase = "renderer") {
  let tx: PreferencesResetTransaction = { transactionId: "durable-id", mode, phase };
  const native = {
    pending: vi.fn(async () => ({ ...tx })),
    acknowledge: vi.fn(async (id: string) => {
      if (id !== tx.transactionId) throw new Error("stale acknowledgement");
      tx = { ...tx, transactionId: "" };
    }),
  };
  return { native, pending: () => tx.transactionId };
}
async function hydrateRealSettingStore() {
  // This import deliberately happens only AFTER recovery, like candidate main.ts.
  const { useSettingStore, createSettingState } = await import("@/stores/setting");
  const pinia = createPinia();
  pinia.use(persistedState);
  createApp({}).use(pinia);
  setActivePinia(pinia);
  const store = useSettingStore();
  expect(store.themeCustomColor).toBe(createSettingState().themeCustomColor);
  expect(store.themeCustomColor).not.toBe("#abcdef");
  return store;
}

it.each(["settings", "all"] as const)(
  "recovers %s after native committed but its receipt was lost before renderer clearing",
  async (mode) => {
    const tx = durableNative(mode);
    const clearRenderer = vi.fn(async () => {});
    expect(
      await executePreferencesReset({
        mode,
        native: {
          reset: async () => {
            throw new Error("transport lost after durable commit");
          },
        },
        current: () => true,
        clearRenderer,
        quit: vi.fn(),
        reportRendererFailure: vi.fn(),
      }),
    ).toEqual({ status: "native-failed" });
    expect(clearRenderer).not.toHaveBeenCalled();
    await recoverPreferencesResetBeforeMount(tx.native, { local: storage, session });
    expect(tx.pending()).toBe("");
    await hydrateRealSettingStore();
    if (mode === "settings") {
      expect(storage.getItem("shortcut-store")).toBe("preserved shortcut fixture");
      expect(storage.getItem("account")).toBe("preserved account fixture");
      expect(backend.stores.get("local-data/local_download_history")).toEqual(["history"]);
      expect(backend.drop).not.toHaveBeenCalled();
    } else {
      expect(storage.getItem("shortcut-store")).toBeNull();
      expect([...backend.stores]).toEqual([["unrelated/store", "untouched"]]);
      expect(session.clear).toHaveBeenCalledOnce();
    }
  },
);

it("owner replacement after receipt retains intent that the next early bootstrap consumes", async () => {
  const tx = durableNative("settings");
  let current = true;
  const clearRenderer = vi.fn(async () => {});
  expect(
    await executePreferencesReset({
      mode: "settings",
      native: {
        reset: async () => {
          current = false;
          return {
            pending: true,
            restartRequired: true,
            transactionId: "durable-id",
            mode: "settings",
          };
        },
      },
      current: () => current,
      clearRenderer,
      quit: vi.fn(),
      reportRendererFailure: vi.fn(),
    }),
  ).toEqual({ status: "stale", nativePending: true });
  expect(clearRenderer).not.toHaveBeenCalled();
  expect(tx.pending()).toBe("durable-id");
  await recoverPreferencesResetBeforeMount(tx.native, { local: storage, session });
  await hydrateRealSettingStore();
});

it("partial renderer cleanup never acknowledges or mounts; next startup retries all requested stores", async () => {
  const tx = durableNative("all");
  backend.drop
    .mockImplementationOnce(async () => {})
    .mockRejectedValueOnce(new Error("DB blocked"));
  const mount = vi.fn();
  await expect(
    recoverPreferencesResetBeforeMount(tx.native, { local: storage, session }).then(mount),
  ).rejects.toThrow();
  expect(mount).not.toHaveBeenCalled();
  expect(tx.native.acknowledge).not.toHaveBeenCalled();
  expect(tx.pending()).toBe("durable-id");
  // A prior store writer may have persisted again before the failed process exited.
  values.set("setting-store", JSON.stringify({ themeCustomColor: "#abcdef" }));
  await recoverPreferencesResetBeforeMount(tx.native, { local: storage, session });
  expect(tx.pending()).toBe("");
  expect([...backend.stores]).toEqual([["unrelated/store", "untouched"]]);
  await hydrateRealSettingStore();
});

it("ack receipt loss/crash safely repeats idempotent renderer clearing before mounting", async () => {
  const tx = durableNative("settings");
  tx.native.acknowledge.mockRejectedValueOnce(new Error("crash before native ack commit"));
  await expect(
    recoverPreferencesResetBeforeMount(tx.native, { local: storage, session }),
  ).rejects.toThrow();
  expect(tx.pending()).toBe("durable-id");
  await recoverPreferencesResetBeforeMount(tx.native, { local: storage, session });
  expect(tx.native.acknowledge).toHaveBeenCalledTimes(2);
  await hydrateRealSettingStore();
});

it("an in-process reload with restart phase cannot clear or load stale preferences", async () => {
  const tx = durableNative("all", "restart");
  const mount = vi.fn();
  await expect(
    recoverPreferencesResetBeforeMount(tx.native, { local: storage, session }).then(mount),
  ).rejects.toThrow();
  expect(storage.getItem("setting-store")).not.toBeNull();
  expect(backend.drop).not.toHaveBeenCalled();
  expect(tx.native.acknowledge).not.toHaveBeenCalled();
  expect(mount).not.toHaveBeenCalled();
});

it("a committed ack with lost response does not replay destructive clearing on the next startup", async () => {
  let pending = true;
  const native = {
    pending: async () => ({
      transactionId: pending ? "tx" : "",
      mode: "all" as const,
      phase: "renderer",
    }),
    acknowledge: vi.fn(async () => {
      pending = false;
      throw new Error("reply lost after commit");
    }),
  };
  await expect(
    recoverPreferencesResetBeforeMount(native, { local: storage, session }),
  ).rejects.toThrow();
  const drops = backend.drop.mock.calls.length;
  await recoverPreferencesResetBeforeMount(native, { local: storage, session });
  expect(backend.drop).toHaveBeenCalledTimes(drops);
  expect(native.acknowledge).toHaveBeenCalledOnce();
  await hydrateRealSettingStore();
});
