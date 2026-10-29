import { describe, expect, it, vi } from "vitest";
import {
  createSystemFontsProvider,
  createSystemFontsSession,
  normalizeSystemFontFamilies,
} from "./systemFonts";

describe("system font provider", () => {
  it("filters, deduplicates, bounds, and sorts family names", () => {
    expect(
      normalizeSystemFontFamilies(["  Inter ", "Inter", "", ".private", null, "Arial\0x", "Arial"]),
    ).toEqual(["Arial", "Inter"]);
  });

  it("does not commit a result after disposal", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const provider = createSystemFontsProvider({
      list: () => new Promise((done) => (resolve = done)),
    });
    const session = createSystemFontsSession(provider);
    const loading = session.load();
    session.dispose();
    resolve(["Late Font"]);
    await loading;
    expect(session.fonts.value).toEqual([]);
  });

  it("keeps the newest owner request", async () => {
    const first = Promise.resolve(["First"]);
    const second = Promise.resolve(["Second"]);
    const list = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const session = createSystemFontsSession(createSystemFontsProvider({ list }));
    await Promise.all([session.load(), session.load()]);
    expect(session.fonts.value).toEqual(["Second"]);
  });
});
