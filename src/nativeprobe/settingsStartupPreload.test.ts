import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const origin = "http://127.0.0.1:19281";
function preload() {
  const go = readFileSync("desktop/nativeprobe_settings_startup.go", "utf8");
  const embedded = go.match(/\/\/go:embed (settings_startup_preload\.js)/);
  const script = embedded
    ? readFileSync(`desktop/${embedded[1]}`, "utf8")
    : go.match(/PreloadScript: `([\s\S]*?)`/)?.[1];
  if (!script) throw new Error("actual-preload-not-found");
  return script.replaceAll("__SETTINGS_STARTUP_ORIGIN__", JSON.stringify(origin));
}
function execute(href: string, failStorage = false) {
  const storage = new Map<string, string>();
  const listeners = new Map<string, (event: object) => void>();
  let accesses = 0;
  const context = {
    location: new URL(href),
    window: {} as Record<string, unknown>,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    addEventListener: (name: string, listener: (event: object) => void) => {
      listeners.set(name, listener);
    },
    localStorage: {
      setItem(key: string, value: string) {
        accesses++;
        if (failStorage) throw new Error("synthetic-storage-denied");
        storage.set(key, value);
      },
    },
  };
  return {
    run: () => runInNewContext(preload(), context),
    storage,
    listeners,
    context,
    accesses: () => accesses,
  };
}

describe("actual settings startup preload", () => {
  it("disables every system capability before the controlled page starts", () => {
    const probe = execute(`${origin}/`);
    probe.run();
    expect(JSON.parse(probe.storage.get("shortcut-store") ?? "{}")).toEqual({ globalOpen: false });
    expect(JSON.parse(probe.storage.get("setting-store") ?? "{}")).toEqual({
      smtcOpen: false,
      preventSleep: false,
      autoPlay: false,
    });
  });
  it.each(["about:blank", "http://127.0.0.1:19282/", "https://foreign.invalid/"])(
    "does not access storage or install observation on %s",
    (href) => {
      const probe = execute(href, true);
      expect(probe.run).not.toThrow();
      expect(probe.accesses()).toBe(0);
      expect(probe.listeners.size).toBe(0);
    },
  );
  it("does not swallow a controlled-page storage failure", () => {
    const probe = execute(`${origin}/`, true);
    expect(probe.run).toThrow("synthetic-storage-denied");
  });
  it("counts unknown errors without retaining messages, URLs or rejection reasons", () => {
    const probe = execute(`${origin}/`);
    probe.run();
    probe.listeners.get("error")?.({
      target: probe.context.window,
      message: "PRIVATE https://private.invalid/token",
      error: new Error("PRIVATE"),
    });
    probe.listeners.get("unhandledrejection")?.({ reason: "PRIVATE" });
    const runtime = probe.context.window.__settingsStartupRuntime;
    expect(runtime).toMatchObject({ errors: 1, rejections: 1, unknownErrors: 2 });
    expect(JSON.stringify(runtime)).not.toContain("PRIVATE");
    expect(JSON.stringify(runtime)).not.toContain("private.invalid");
  });
});
