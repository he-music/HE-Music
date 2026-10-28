import { afterEach, expect, it, vi } from "vitest";
import { isVNode } from "vue";
import type { SongInfo } from "@/types/main.hemusic";

const mocks = vi.hoisted(() => {
  const destroy = vi.fn();
  return {
    platform: { kind: "mygo" },
    editor: { name: "LegacyEditor" },
    download: { name: "LegacyDownload" },
    edit: vi.fn<(song: SongInfo) => Promise<void>>(async () => {}),
    save: vi.fn<(song: SongInfo) => Promise<void>>(async () => {}),
    create: vi.fn<(options: { content: () => unknown }) => { destroy: () => void }>(() => ({
      destroy,
    })),
  };
});
vi.mock("@/platform", () => ({ platform: mocks.platform }));
vi.mock("./mygoFileModals", () => ({
  openMygoSongInfoEditor: mocks.edit,
  openMygoDownloadSong: mocks.save,
}));
vi.mock("./auth", () => ({ isLogin: () => false }));
vi.mock("naive-ui", () => ({ NScrollbar: { name: "Scrollbar" } }));
vi.mock("@/router", () => ({ default: {} }));
vi.mock("@/stores", () => ({ usePlatformStore: () => ({}) }));
vi.mock("@/api/platform", () => ({ FeatureSupportFlag: {} }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/Modal/SongInfoEditor.vue", () => ({ default: mocks.editor }));
vi.mock("@/components/Modal/DownloadSong.vue", () => ({ default: mocks.download }));

const song: SongInfo = {
  id: "fixture",
  platform: "fixture",
  name: "fixture song",
  subtitle: "",
  artists: "artist",
  album: "album",
  duration: 1,
  mv_id: "",
  cover: "",
  links: [{ name: "320", quality: 320, format: "mp3", size: "1 MiB", url: "" }],
};
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function prepare(kind: string) {
  mocks.platform.kind = kind;
  vi.stubGlobal("window", {
    $modal: { create: mocks.create },
    $message: { warning: vi.fn(), error: vi.fn() },
  });
}
it("routes mygo editing and downloading through the owned native helpers", async () => {
  prepare("mygo");
  const modal = await import("./modal");
  await modal.openSongInfoEditor(song);
  await modal.openDownloadSong(song);
  expect(mocks.edit).toHaveBeenCalledWith(song);
  expect(mocks.save).toHaveBeenCalledWith(song);
  expect(mocks.create).not.toHaveBeenCalled();
});
it.each(["electron", "web"])("preserves the existing %s modal paths", async (kind) => {
  prepare(kind);
  const modal = await import("./modal");
  await modal.openSongInfoEditor(song);
  const editor = mocks.create.mock.calls[0]?.[0].content();
  expect(isVNode(editor) && editor.type).toBe(mocks.editor);
  await modal.openDownloadSong(song);
  const download = mocks.create.mock.calls[1]?.[0].content();
  expect(isVNode(download) && download.type).toBe(mocks.download);
  expect(mocks.edit).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
