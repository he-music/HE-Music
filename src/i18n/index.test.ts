import { expect, it, vi } from "vitest";

it("uses Composition API and keeps exported translations and number formats in sync with the locale", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { default: i18n, t, n } = await import("./index");
  try {
    expect(i18n.mode).toBe("composition");
    for (const locale of ["en", "zh-CN"] as const) {
      i18n.global.locale.value = locale;
      expect(t("common.play")).toBe(locale === "en" ? "Play" : "播放");
      expect(n(12345, "number")).toBe(
        new Intl.NumberFormat(locale, {
          style: "decimal",
          notation: "compact",
          compactDisplay: "short",
          maximumFractionDigits: 2,
        }).format(12345),
      );
    }
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Legacy API mode");
  } finally {
    i18n.global.locale.value = "zh-CN";
    warn.mockRestore();
  }
});
