import { afterEach, expect, it, vi } from "vitest";
import { isVNode, toValue } from "vue";
import { renderToString } from "vue/server-renderer";
import { FilesSession, filesSession } from "@/platform/filesSession";
import type { PlatformFiles } from "@/platform/files";
import { createMygoDownloadSettings } from "./localDownloadSettings";

const state = vi.hoisted(() => ({ downloadPath: "" }));
vi.mock("@/stores", () => ({ useSettingStore: () => state }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(async () => {
  await filesSession.value?.dispose();
  state.downloadPath = "";
  vi.unstubAllGlobals();
});
async function fixture() {
  const native: PlatformFiles = {
    begin: async () => ({ epoch: 1 }),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 1, displayPath: "/Music/<My Downloads>" },
      relation: "",
      existingToken: "",
    })),
    revokeDirectory: async () => {},
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: async () => {},
  };
  const owner = new FilesSession(native);
  await owner.start();
  const warning = vi.fn();
  vi.stubGlobal("window", { $message: { warning, error: vi.fn() } });
  const scan = vi.fn(async () => {});
  const item = createMygoDownloadSettings({ scanLibrary: scan }).groups[0].items[0];
  const choose = async () => {
    await item.action?.(undefined);
  };
  const description = async () => {
    const value = toValue(item.description);
    return isVNode(value) ? renderToString(value) : String(value);
  };
  return { native, owner, item, choose, description, warning, scan };
}
it("shows only the selected path as plain text without extra status explanations", async () => {
  const f = await fixture();
  await f.choose();
  expect(state.downloadPath).toBe("/Music/<My Downloads>");
  expect(await f.description()).toContain("/Music/&lt;My Downloads&gt;");
  expect(await f.description()).not.toContain("mygo.downloads.directory");
  await f.owner.revokeDirectory("grant");
  expect(await f.description()).not.toContain("mygo.downloads.directory");
  expect(await f.description()).toContain("/Music/&lt;My Downloads&gt;");
});
it("selects an already authorized directory as the download destination instead of silently ignoring it", async () => {
  const f = await fixture();
  await f.owner.chooseDirectory();
  vi.mocked(f.native.chooseDirectory).mockResolvedValueOnce({
    status: "overlap",
    grant: null,
    relation: "duplicate",
    existingToken: "grant",
  });
  await f.choose();
  expect(state.downloadPath).toBe("/Music/<My Downloads>");
  expect(f.scan).toHaveBeenCalledOnce();
});
it("explains a parent or child overlap and keeps the prior destination", async () => {
  const f = await fixture();
  await f.choose();
  vi.mocked(f.native.chooseDirectory).mockResolvedValueOnce({
    status: "overlap",
    grant: null,
    relation: "child",
    existingToken: "grant",
  });
  await f.choose();
  expect(state.downloadPath).toBe("/Music/<My Downloads>");
  expect(f.warning).toHaveBeenCalledWith("message.local_path_overlapping");
});
