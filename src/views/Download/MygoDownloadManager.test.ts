import { afterEach, expect, it, vi } from "vitest";
import * as Vue from "vue";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";
import type { FilesSession } from "@/platform/filesSession";
import type { ScanEntry } from "@/platform/mygo.bindings";
import { useMygoDownloadTasks, type MygoDownloadTasksOwner } from "@/composables/mygoDownloadTasks";
import {
  useMygoDownloadedSongs,
  type MygoDownloadedSongsOwner,
} from "@/composables/mygoDownloadedSongs";
import { LocalFileActions } from "@/platform/localFileActions";
import { mountProductionSfc, flushSfcHost, type SfcHostNode } from "@/test/productionSfc";

type Owner = MygoDownloadTasksOwner &
  MygoDownloadedSongsOwner &
  Pick<FilesSession, "fileActionAccess">;
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});
const record = (id: string, extra: Partial<LocalDownloadTask> = {}): LocalDownloadTask => ({
  id,
  label: `Original ${id}`,
  filename: `${id}.mp3`,
  quality: "320mp3",
  song: { id: `online-${id}`, platform: "provider" },
  display: { artists: "Original artist", album: "Album", cover: "/images/song.jpg", duration: 180 },
  target: { directory: "/Downloads", relativePath: `${id}.mp3` },
  done: false,
  committed: false,
  phase: "active",
  received: 10,
  total: 100,
  percent: 10,
  refresh: "none",
  retryable: false,
  ...extra,
});
const saved = (id = "saved", extra: Partial<LocalDownloadTask> = {}) =>
  record(id, { done: true, committed: true, phase: "success", percent: 100, ...extra });
function entry(id = "saved"): ScanEntry {
  return {
    ref: { grantToken: "grant", fileId: `file-${id}`, version: "v1", relativePath: `${id}.mp3` },
    relativePath: `${id}.mp3`,
    filename: `${id}.mp3`,
    size: 100,
    metadata: {
      Title: "File tag title",
      Artists: ["File tag artist"],
      Album: "File album",
      DurationSeconds: 180,
      Container: "MP3",
      AlbumArtists: [],
      Comment: "",
      Lyrics: "",
      Pictures: [],
      PicturesLoaded: false,
      BitrateKbps: 320,
      SampleRateHz: 44100,
      Channels: 2,
      BitsPerSample: 16,
      Codec: "MP3",
    },
  };
}
function setup(
  rows: LocalDownloadTask[] = [saved()],
  initialRoute = "download-downloaded",
  os = "darwin",
) {
  const tasks = Vue.shallowRef<readonly LocalDownloadTask[]>(rows);
  const queue = {
    tasks,
    retry: vi.fn(async () => "retry"),
    refresh: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    retire: vi.fn(async () => true),
    remove: vi.fn(async (id: string) => {
      tasks.value = tasks.value.filter((task) => task.id !== id);
      return true;
    }),
  };
  const entries = Vue.shallowRef<readonly ScanEntry[]>([]);
  const grants = Vue.shallowRef([{ token: "grant", epoch: 1, displayPath: "/Downloads" }]);
  const ready = Vue.shallowRef(true);
  const reveal = vi.fn(async () => ({ code: "ok", removed: false }));
  const removeFile = vi.fn(async () => ({ code: "ok", removed: true }));
  const fileActionAccess = vi.fn(() => ({ current: () => true, reveal, remove: removeFile }));
  const owner = Vue.shallowRef<Owner | undefined>({
    downloads: queue,
    ready,
    directories: Vue.computed(() => grants.value),
    get libraryEntries() {
      return entries.value;
    },
    fileActionAccess,
  });
  const scan = vi.fn(async () => {});
  const refreshAfterWrite = vi.fn(async () => {
    entries.value = [];
  });
  const local = Vue.shallowRef({
    refreshAfterDownload: scan,
    refreshAfterWrite,
    scanning: Vue.shallowRef(false),
  });
  const play = vi.fn();
  const playOne = vi.fn();
  const music = Vue.reactive({ playSong: { id: "", platform: "" } });
  const route = Vue.reactive({ name: initialRoute });
  const navigate = vi.fn(async ({ name }: { name: string }) => {
    route.name = name;
  });
  const updated = vi.fn();
  const warning = vi.fn();
  const success = vi.fn();
  vi.stubGlobal("window", { $dialog: { warning }, $message: { success, error: vi.fn() } });
  const host = mountProductionSfc(
    new URL("./MygoDownloadManager.vue", import.meta.url),
    {
      "@/platform/filesSession": { filesSession: owner },
      "@/components/Local/LocalScanIssues.vue": {
        default: Vue.defineComponent({ render: () => null }),
      },
      "@/components/Local/DownloadedArtwork.vue": {
        default: Vue.defineComponent({
          props: ["song", "fallback"],
          setup: (props) => () => Vue.h("downloaded-artwork", { ...props }),
        }),
      },
      "@/composables/mygoDownloadTasks": { useMygoDownloadTasks },
      "@/composables/mygoDownloadedSongs": { useMygoDownloadedSongs },
      "@/platform/localFilesSession": {
        localFilesSession: local,
        nativeLocalEntry: (id: string) =>
          entries.value.find((item) => id === `mygo-local:${item.ref.fileId}`),
      },
      "@/platform/localFileActions": { LocalFileActions },
      "@/stores": { useMusicStore: () => music },
      "@/utils/player": { usePlayer: () => ({ updatePlayList: play, addNextSong: playOne }) },
      "vue-router": { useRoute: () => route, useRouter: () => ({ push: navigate }) },
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/utils/env": { isWin: os === "win32" },
      "fixture-updates": { updated },
    },
    [
      "NText",
      "NFlex",
      "NButton",
      "NTabs",
      "NTab",
      "NScrollbar",
      "NProgress",
      "NEmpty",
      "NDropdown",
      "SImage",
      "SvgIcon",
    ],
    'import { onUpdated } from "vue"; import { updated } from "fixture-updates"; onUpdated(updated);',
  );
  cleanups.push(host.close);
  const text = (target: SfcHostNode): string => target.text + target.children.map(text).join("");
  const row = (id: string) => {
    const found = host.all().find((node) => node.props["data-task-id"] === id);
    if (!found) throw new Error(`Missing task ${id}`);
    return found;
  };
  const button = (label: string, target?: SfcHostNode) =>
    host
      .all(target)
      .find(
        (node) =>
          node.tag === "NButton" && (node.props["aria-label"] === label || text(node) === label),
      );
  const click = async (label: string, target?: SfcHostNode) => {
    const found = button(label, target);
    if (!found || found.props.disabled || typeof found.props.onClick !== "function")
      throw new Error(`Missing or disabled ${label}`);
    await found.props.onClick();
    await flushSfcHost();
  };
  const tab = async (name: "completed" | "downloading") => {
    const tabs = host.all().find((node) => node.tag === "NTabs")!;
    const change = tabs.props["onUpdate:value"];
    if (typeof change !== "function") throw new Error("Missing tabs");
    change(name);
    await flushSfcHost();
  };
  const menu = async (id: string) => {
    const open = row(id).props.onContextmenu;
    if (typeof open !== "function") throw new Error("Missing task menu");
    open({ clientX: 10, clientY: 20, preventDefault() {} });
    await flushSfcHost();
    return host.all().find((node) => node.tag === "NDropdown")!;
  };
  const select = async (id: string, key: string) => {
    const dropdown = await menu(id);
    const handler = dropdown.props.onSelect;
    if (typeof handler !== "function") throw new Error("Missing dropdown handler");
    handler(key);
    await flushSfcHost();
  };
  return {
    ...host,
    tasks,
    entries,
    grants,
    ready,
    owner,
    queue,
    scan,
    row,
    text: () =>
      host
        .all()
        .map((node) => node.text)
        .join(""),
    button,
    click,
    tab,
    menu,
    select,
    reveal,
    removeFile,
    fileActionAccess,
    refreshAfterWrite,
    play,
    playOne,
    warning,
    success,
    music,
    updated,
    navigate,
  };
}
it("shows the native download failure reason in the task row", async () => {
  const f = setup(
    [record("failed", { phase: "failed", done: true, warning: "http_rejected", retryable: true })],
    "download-downloading",
  );
  await flushSfcHost();
  expect(f.text()).toContain("mygo.downloads.phase.failed");
  expect(f.text()).toContain("local_download.warning.http_rejected");
});

it("shows a saved Windows download as completed while retaining genuine write warnings", async () => {
  const f = setup(
    [saved("saved", { phase: "saved", warning: "durability_uncertain" })],
    "download-downloaded",
    "win32",
  );
  await flushSfcHost();
  expect(f.text()).toContain("common.completed");
  expect(f.text()).not.toContain("local_download.warning.durability_uncertain");
  expect(f.text()).toContain("mygo.downloads.fileUnavailable");
  for (const warning of ["sync_failed", "partial_committed", "cleanup_failed"] as const) {
    f.tasks.value = [saved("saved", { phase: "saved", warning })];
    await flushSfcHost();
    expect(f.text()).toContain(`local_download.warning.${warning}`);
  }
});

it("retains an unexpected durability warning on other platforms", async () => {
  const f = setup([saved("saved", { phase: "saved", warning: "durability_uncertain" })]);
  await flushSfcHost();
  expect(f.text()).toContain("local_download.warning.durability_uncertain");
});

it("renders completed task records without scanning or importing arbitrary directory songs", async () => {
  const f = setup();
  expect(f.text()).toContain("Original saved");
  expect(f.text()).toContain("Original artist");
  expect(f.text()).toContain("320mp3");
  expect(f.text()).not.toContain("provider");
  expect(f.tasks.value[0].song?.platform).toBe("provider");
  expect(f.text()).toContain("mygo.downloads.fileUnavailable");
  f.entries.value = [entry("unrelated")];
  await flushSfcHost();
  expect(f.all().filter((node) => node.props["data-task-id"])).toHaveLength(1);
  expect(f.text()).not.toContain("File tag title");
  expect(f.scan).not.toHaveBeenCalled();
  expect(f.button("mygo.downloads.refreshFiles")).toBeUndefined();
  expect(f.button("mygo.downloads.refresh")).toBeUndefined();
});
it("keeps a saved task completed while indexing is pending, failed, missing, or access is revoked", async () => {
  const f = setup([saved("saved", { refresh: "pending" })]);
  expect(f.text()).toContain("mygo.downloads.readingFile");
  expect(f.text()).not.toContain("mygo.downloads.fileUnavailable");
  expect(f.row("saved")).toBeDefined();
  f.tasks.value = [saved("saved", { refresh: "failed" })];
  f.ready.value = false;
  await flushSfcHost();
  expect(f.text()).toContain("mygo.downloads.fileUnavailable");
  expect(f.row("saved")).toBeDefined();
  expect(f.text()).not.toContain("mygo.downloads.scanFailed");
  expect(f.button("common.play", f.row("saved"))?.props.disabled).toBe(true);
  await f.tab("downloading");
  expect(f.all().some((node) => node.props["data-task-id"] === "saved")).toBe(false);
});
it("uses the original task identity for menus and only authorizes file actions through current scan references", async () => {
  const f = setup();
  const disabled = await f.menu("saved");
  expect(disabled.props.options).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "play", disabled: true }),
      expect.objectContaining({ key: "remove", disabled: false }),
    ]),
  );
  expect(disabled.props.options).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ key: "edit" })]),
  );
  f.entries.value = [entry()];
  await flushSfcHost();
  await f.click("common.play", f.row("saved"));
  expect(f.playOne).toHaveBeenCalledWith(
    expect.objectContaining({ id: "mygo-local:file-saved", path: "saved.mp3" }),
    true,
  );
  await f.select("saved", "reveal");
  expect(f.fileActionAccess).toHaveBeenCalledWith(entry().ref);
  expect(f.reveal).toHaveBeenCalledOnce();
});
it("restores artwork from the current downloaded file and enables deleting other loaded files", async () => {
  const f = setup([saved()]);
  f.entries.value = [entry()];
  await flushSfcHost();
  const artwork = f.all().find((node) => node.tag === "downloaded-artwork");
  expect(artwork?.props.song).toMatchObject({ id: "mygo-local:file-saved", path: "saved.mp3" });
  const menu = await f.menu("saved");
  expect(menu.props.options).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: "delete-file", disabled: false })]),
  );
  f.music.playSong = { id: "mygo-local:file-saved", platform: "local" };
  await flushSfcHost();
  const playingMenu = await f.menu("saved");
  expect(playingMenu.props.options).toEqual(
    expect.arrayContaining([expect.objectContaining({ key: "delete-file", disabled: true })]),
  );
});
it("removes a completed task record while preserving its downloaded file", async () => {
  const f = setup();
  f.entries.value = [entry()];
  await flushSfcHost();
  await f.click("mygo.downloads.remove", f.row("saved"));
  expect(f.queue.remove).toHaveBeenCalledWith("saved");
  expect(f.tasks.value).toHaveLength(0);
  expect(f.entries.value).toHaveLength(1);
  expect(f.removeFile).not.toHaveBeenCalled();
});
it("confirms file deletion separately and keeps the completed record after deleting its file", async () => {
  const f = setup();
  f.entries.value = [entry()];
  await flushSfcHost();
  await f.select("saved", "delete-file");
  expect(f.removeFile).not.toHaveBeenCalled();
  const dialog = f.warning.mock.calls[0][0];
  expect(dialog.content).toBe("mygo.downloads.deleteFileConfirm");
  await dialog.onPositiveClick();
  await flushSfcHost();
  expect(f.removeFile).toHaveBeenCalledOnce();
  expect(f.refreshAfterWrite).toHaveBeenCalledOnce();
  expect(f.queue.remove).not.toHaveBeenCalled();
  expect(f.tasks.value[0].committed).toBe(true);
  expect(f.row("saved")).toBeDefined();
  expect(f.text()).toContain("mygo.downloads.fileUnavailable");
});
it("rechecks permissions and playback when a file deletion dialog is accepted", async () => {
  const f = setup();
  f.entries.value = [entry()];
  await flushSfcHost();
  await f.select("saved", "delete-file");
  f.music.playSong = { id: "mygo-local:file-saved", platform: "local" };
  await f.warning.mock.calls[0][0].onPositiveClick();
  expect(f.removeFile).not.toHaveBeenCalled();
  f.music.playSong = { id: "", platform: "" };
  f.ready.value = false;
  await f.warning.mock.calls[0][0].onPositiveClick();
  expect(f.removeFile).not.toHaveBeenCalled();
});
it("filters the same records by status and does not expose manual refresh controls", async () => {
  const f = setup([
    record("active"),
    record("failed", { done: true, phase: "failed", retryable: true }),
    saved(),
  ]);
  await f.tab("downloading");
  expect(f.row("active")).toBeDefined();
  expect(f.row("failed")).toBeDefined();
  expect(f.button("mygo.downloads.refresh")).toBeUndefined();
  expect(f.button("download.retry")).toBeUndefined();
  await f.click("mygo.downloads.retry", f.row("failed"));
  expect(f.queue.retry).toHaveBeenCalledWith("failed");
  await f.click("mygo.downloads.remove", f.row("active"));
  expect(f.queue.remove).toHaveBeenCalledWith("active");
  expect(f.queue.refresh).not.toHaveBeenCalled();
});
it("ignores an old deletion dialog even if another menu opens in a replacement owner", async () => {
  const f = setup();
  f.entries.value = [entry()];
  await flushSfcHost();
  await f.select("saved", "delete-file");
  const dialog = f.warning.mock.calls[0][0];
  f.owner.value = { ...f.owner.value! };
  await flushSfcHost();
  await f.menu("saved");
  await dialog.onPositiveClick();
  await flushSfcHost();
  expect(f.removeFile).not.toHaveBeenCalled();
});
it("suppresses file-index changes and success feedback from a late deletion response after owner replacement", async () => {
  const f = setup();
  f.entries.value = [entry()];
  await flushSfcHost();
  let finish!: (value: { code: string; removed: boolean }) => void;
  f.removeFile.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await f.select("saved", "delete-file");
  const deleting = f.warning.mock.calls[0][0].onPositiveClick();
  await flushSfcHost();
  expect(f.removeFile).toHaveBeenCalledOnce();
  f.owner.value = { ...f.owner.value! };
  await flushSfcHost();
  finish({ code: "ok", removed: true });
  await deleting;
  await flushSfcHost();
  expect(f.refreshAfterWrite).not.toHaveBeenCalled();
  expect(f.success).not.toHaveBeenCalled();
  expect(f.tasks.value).toHaveLength(1);
});
it("shows specific optional failure reasons while the saved audio remains completed and playable", async () => {
  const f = setup([
    saved("saved", {
      issues: [{ stage: "cover", reason: "http_rejected", httpStatus: 404 }],
    }),
  ]);
  f.entries.value = [entry()];
  await flushSfcHost();
  expect(f.text()).toContain("common.completed");
  expect(f.text()).toContain("local_download.issue.cover");
  expect(f.text()).toContain("local_download.reason.http_rejected");
  expect(f.text()).toContain("HTTP 404");
  expect(f.button("mygo.downloads.retry", f.row("saved"))).toBeUndefined();
  expect(f.button("common.play", f.row("saved"))?.props.disabled).toBe(false);
});
it("does not rerender completed rows for another task's progress but updates necessary task and file changes", async () => {
  const complete = saved();
  const f = setup([complete, record("active")]);
  await flushSfcHost();
  const updates = f.updated.mock.calls.length;
  f.tasks.value = [complete, record("active", { received: 90, percent: 90 })];
  await flushSfcHost();
  expect(f.updated).toHaveBeenCalledTimes(updates);
  f.entries.value = [entry()];
  await flushSfcHost();
  expect(f.button("common.play", f.row("saved"))?.props.disabled).toBe(false);
  f.tasks.value = [{ ...complete, label: "Updated task" }];
  await flushSfcHost();
  expect(f.text()).toContain("Updated task");
});
