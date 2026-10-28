import { expect, it, vi } from "vitest";

vi.mock("@/platform/filesSession", () => ({ filesSession: { value: undefined } }));
vi.mock("@/platform/localFilesSession", () => ({ nativeLocalEntry: vi.fn() }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/api/song", () => ({
  get songUrl() {
    throw new Error("API export is not initialized during the request/modal import cycle");
  },
}));

it("defers the API export read until download resolution instead of reading it at module startup", async () => {
  const modals = await import("./mygoFileModals");
  expect(modals.openMygoSongInfoEditor).toBeTypeOf("function");
  expect(modals.openMygoDownloadSong).toBeTypeOf("function");
});
