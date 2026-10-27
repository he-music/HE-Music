import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const origin = "http://127.0.0.1:19281";
const source = readFileSync("desktop/nativeprobe_settings_files.go", "utf8");
const script = source.match(/PreloadScript: fmt.Sprintf\(`([\s\S]*?)`/)?.[1];
if (!script) throw new Error("actual-fileprobe-preload-not-found");
const preload = script.replace("%s", JSON.stringify(origin));

describe("actual settings fileprobe preload scope", () => {
  it.each(["about:blank", "http://127.0.0.1:19282/", "https://foreign.invalid/"])(
    "skips opaque or foreign document %s",
    (href) => {
      const context = {
        location: new URL(href),
        get localStorage() {
          throw new Error("synthetic-forbidden-storage");
        },
      };
      expect(() => runInNewContext(preload, context)).not.toThrow();
    },
  );
  it("writes only diagnostic disabled values on the owned page", () => {
    const store = new Map<string, string>();
    runInNewContext(preload, {
      location: new URL(`${origin}/`),
      localStorage: { setItem: (key: string, value: string) => store.set(key, value) },
      window: {},
      addEventListener: () => {},
    });
    expect(JSON.parse(store.get("shortcut-store") ?? "{}")).toEqual({ globalOpen: false });
    expect(JSON.parse(store.get("setting-store") ?? "{}")).toEqual({
      smtcOpen: false,
      preventSleep: false,
      autoPlay: false,
    });
  });
  it("propagates a storage failure on the owned page", () => {
    expect(() =>
      runInNewContext(preload, {
        location: new URL(`${origin}/`),
        localStorage: {
          setItem() {
            throw new Error("synthetic-owned-storage-failure");
          },
        },
      }),
    ).toThrow("synthetic-owned-storage-failure");
  });
});
