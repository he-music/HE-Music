import { afterEach, expect, it, vi } from "vitest";
import { reactive, shallowRef } from "vue";
import { mountProductionSfc, flushSfcHost, emitHostEvent } from "@/test/productionSfc";
import { parseApplicationBackup } from "@/platform/applicationBackup";

const native = vi.hoisted(() => ({ restore: vi.fn(async () => {}) }));
vi.mock("@/platform/mygo.bindings", () => ({ DesktopStorage: native }));
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mount(state = reactive({ pending: false }), operation: "import" | "export" = "import") {
  const reload = vi.fn();
  const error = vi.fn();
  let dialog: { onPositiveClick(): Promise<void>; onNegativeClick(): void } | undefined;
  vi.stubGlobal("window", {
    location: { reload },
    $message: { error },
    $dialog: {
      warning: (value: typeof dialog) => {
        dialog = value;
      },
      error: vi.fn(),
    },
  });
  const dispose = vi.fn(async () => {});
  const owner = { dispose, current: () => true };
  const session = { ready: shallowRef(true), capturePreferencesResetOwner: () => owner };
  const files = shallowRef(session);
  const page = mountProductionSfc(
    new URL("./ApplicationDataTransfer.vue", import.meta.url),
    {
      "file-saver": { saveAs: vi.fn() },
      "@/i18n": { t: (key: string) => key },
      "@/platform": { platform: { kind: "mygo" } },
      "@/platform/filesSession": { filesSession: files },
      "@/platform/applicationStorage": { flushApplicationWrites: async () => {} },
      "@/platform/mygo.bindings": { DesktopStorage: native },
      "@/platform/applicationBackup": {
        applicationBackupMaxBytes: 128 << 20,
        parseApplicationBackup,
        exportApplicationBackup: vi.fn(),
      },
    },
    ["NSpace", "NButton"],
    "",
    { operation, state },
  );
  stops.push(page.close);
  const choose = async (text: string) => {
    const input = page.all().find((node) => node.tag === "input");
    if (!input) throw new Error("missing file input");
    Object.assign(input, { files: [new File([text], "data.json")] });
    emitHostEvent(input, "onChange");
    await flushSfcHost();
  };
  return {
    ...page,
    choose,
    reload,
    error,
    dispose,
    dialog: () => {
      if (!dialog) throw new Error("missing confirmation");
      return dialog;
    },
  };
}
const backup = JSON.stringify({ format: "he-music-application-data", version: 1, records: [] });

it("validates before disposing the live file owner and honors cancellation", async () => {
  const page = mount();
  await page.choose("invalid");
  expect(page.error).toHaveBeenCalledOnce();
  expect(page.dispose).not.toHaveBeenCalled();
  await page.choose(backup);
  const dialog = page.dialog();
  dialog.onNegativeClick();
  await dialog.onPositiveClick();
  expect(page.dispose).not.toHaveBeenCalled();
  expect(native.restore).not.toHaveBeenCalled();
  expect(page.reload).not.toHaveBeenCalled();
});

it("drains the current owner before restoration and reloads only after durable native completion", async () => {
  let finish: (() => void) | undefined;
  native.restore.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const page = mount();
  await page.choose(backup);
  const operation = page.dialog().onPositiveClick();
  await vi.waitFor(() => expect(native.restore).toHaveBeenCalledOnce());
  expect(page.dispose).toHaveBeenCalledOnce();
  expect(page.reload).not.toHaveBeenCalled();
  page.close();
  finish?.();
  await operation;
  expect(page.reload).toHaveBeenCalledOnce();
});

it("keeps both backup actions disabled while either operation is pending", async () => {
  const state = reactive({ pending: false });
  const exportPage = mount(state, "export");
  const importPage = mount(state);
  await importPage.choose(backup);
  expect(state.pending).toBe(true);
  for (const page of [exportPage, importPage]) {
    expect(page.all().find((node) => node.tag === "NButton")?.props.disabled).toBe(true);
  }
  importPage.dialog().onNegativeClick();
  await flushSfcHost();
  expect(state.pending).toBe(false);
  for (const page of [exportPage, importPage]) {
    expect(page.all().find((node) => node.tag === "NButton")?.props.disabled).toBe(false);
  }
});
