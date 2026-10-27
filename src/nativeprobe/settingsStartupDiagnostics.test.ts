import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vue", () => ({ nextTick: () => Promise.resolve() }));
const prepare = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./settingsSurface", () => ({
  prepareKnownSettingsStartup: prepare,
  settingsStartupDiagnostics: () => [],
}));

async function observation() {
  vi.resetModules();
  vi.useFakeTimers();
  const runtime: Record<string, unknown> = {
    documentId: "00000000-0000-4000-8000-000000000001",
    errors: 0,
    rejections: 0,
    unknownErrors: 0,
  };
  const document = {
    body: {},
    querySelectorAll: (selector?: string): object[] => {
      void selector;
      return [];
    },
    visibilityState: "visible",
    hidden: false,
    hasFocus: () => true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const disconnect = vi.fn();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    __settingsStartupRuntime: runtime,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const module = await import("./settingsStartupDiagnostics");
  return { module, runtime, document, disconnect };
}
afterEach(() => {
  prepare.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("settingsStartupDiagnostics final contract", () => {
  it("keeps the initial preparation separate from a subsequently unsafe surface", async () => {
    const { module, document } = await observation();
    const initial = await module.observeSettingsStartup();
    expect(initial).toHaveProperty("initialPreparationPassed", true);
    document.querySelectorAll = (selector?: string) => (selector === ".n-drawer" ? [{}] : []);
    const final = module.readStartupObservation();
    expect(final).toHaveProperty("initialPreparationPassed", true);
    expect(final).toHaveProperty("finalSurfaceSafe", false);
  });
  it("fails closed when a required runtime counter is absent", async () => {
    const { module, runtime } = await observation();
    delete runtime.errors;
    await module.observeSettingsStartup();
    expect(module.readStartupObservation()).toHaveProperty("finalSurfaceSafe", false);
  });
  it("unknown error counts fail final safety without retaining error content", async () => {
    const { module, runtime } = await observation();
    await module.observeSettingsStartup();
    runtime.unknownErrors = 1;
    const final = module.readStartupObservation();
    expect(final).toHaveProperty("finalSurfaceSafe", false);
    expect(final.current).toHaveProperty("unknownErrors", 1);
  });
  it("cleans up owned observation immediately on preparation failure", async () => {
    const { module, disconnect } = await observation();
    prepare.mockRejectedValueOnce(new Error("PRIVATE https://private.invalid/token"));
    const result = await module.observeSettingsStartup();
    expect(result.current.active).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(prepare).toHaveBeenCalledOnce();
  });
  it.each(["vite-error-overlay", ".n-drawer", ".main-setting"])(
    "latches an observed %s across direct reads after recovery",
    async (unsafeSelector) => {
      const { module, document } = await observation();
      await module.observeSettingsStartup();
      document.querySelectorAll = (selector?: string) => (selector === unsafeSelector ? [{}] : []);
      expect(module.readStartupObservation().finalSurfaceSafe).toBe(false);
      document.querySelectorAll = () => [];
      const recovered = module.readStartupObservation();
      expect(recovered.current.empty).toBe(true);
      expect(recovered.initialPreparationPassed).toBe(true);
      expect(recovered.unknownFailures).toBe(0);
      expect(recovered.finalSurfaceSafe).toBe(false);
    },
  );
  it.each([16, 24])("latches unsafe after the %i snapshot cap is exhausted", async (cap) => {
    const { module, document } = await observation();
    let notify: ((records: Array<{ target: object }>) => void) | undefined;
    class SurfaceTarget {
      closest() {
        return true;
      }
    }
    vi.stubGlobal("Element", SurfaceTarget);
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: (records: Array<{ target: object }>) => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    await module.observeSettingsStartup();
    const mutate = () => {
      if (!notify) throw new Error("synthetic-observer-not-installed");
      notify([{ target: new SurfaceTarget() }]);
    };
    for (let count = 0; count < 30; count++) {
      if (cap === 16) mutate();
      else module.stopStartupObservation();
    }
    expect(module.readStartupObservation().snapshots).toHaveLength(cap);
    document.querySelectorAll = (selector?: string) => (selector === ".n-drawer" ? [{}] : []);
    if (cap === 16) mutate();
    else module.startupSnapshot();
    document.querySelectorAll = () => [];
    const recovered = module.readStartupObservation();
    expect(recovered.snapshots).toHaveLength(cap);
    expect(recovered.current.empty).toBe(true);
    expect(recovered.unknownFailures).toBe(0);
    expect(recovered.finalSurfaceSafe).toBe(false);
  });
});
