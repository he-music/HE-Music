import { afterEach, expect, it, vi } from "vitest";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const imported = "data:image/jpeg;base64,imported";
const convert = vi.fn();
const update = vi.fn();
const loading = vi.fn();
const error = vi.fn();
let close: (() => void) | undefined;
class Input {
  value = "selected";
  files = [new File(["fixture"], "cover.png", { type: "image/png" })];
}
function pendingCover() {
  const callbacks: { resolve: (value: string) => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<string>((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });
  return { promise, ...callbacks };
}
function mount(cover = "") {
  vi.stubGlobal("HTMLInputElement", Input);
  vi.stubGlobal("window", { $message: { error } });
  const host = mountProductionSfc(
    new URL("./LocalPlaylistCoverPicker.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/platform/gateway": { gatewayProxyUrl: (url: string) => url },
      "@/utils/localPlaylistCover": {
        importLocalPlaylistCover: convert,
        localPlaylistCoverAccept: "image/png",
      },
    },
    ["NFlex", "NImage", "NButton", "NInput"],
    "",
    {
      modelValue: cover,
      "onUpdate:modelValue": update,
      onLoading: loading,
    },
  );
  close = host.close;
  return host;
}
function select(host: ReturnType<typeof mount>) {
  const event = new Event("change");
  const input = new Input();
  Object.defineProperty(event, "target", { value: input });
  emitHostEvent(
    host.all().find((node) => node.tag === "input")!,
    "onChange",
    event,
  );
  expect(input.value).toBe("");
}
function click(host: ReturnType<typeof mount>, label: string) {
  const node = host
    .all()
    .find(
      (node) => node.tag === "NButton" && node.children.some((child) => child.text.includes(label)),
    );
  if (!node) throw new Error(`Missing ${label}`);
  emitHostEvent(node, "onClick");
}
afterEach(() => {
  close?.();
  close = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("本地封面可预览、移除，图片链接输入框不显示图片数据", async () => {
  const host = mount(imported);
  expect(host.all().find((node) => node.tag === "NImage")?.props.src).toBe(imported);
  click(host, "local_playlists.cover_link");
  await flushSfcHost();
  expect(host.all().find((node) => node.tag === "NInput")?.props.value).toBe("");
  click(host, "local_playlists.remove_cover");
  expect(update).toHaveBeenLastCalledWith("");
});
it("连续选择图片时只接受最新一次导入结果", async () => {
  const first = pendingCover();
  const second = pendingCover();
  convert.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const host = mount();
  select(host);
  select(host);
  first.resolve("data:image/jpeg;base64,old");
  await flushSfcHost();
  expect(update).not.toHaveBeenCalled();
  expect(loading).toHaveBeenLastCalledWith(true);
  second.resolve(imported);
  await flushSfcHost();
  expect(update).toHaveBeenCalledExactlyOnceWith(imported);
  expect(loading).toHaveBeenLastCalledWith(false);
});
it("移除封面会取消未完成导入，旧结果不会恢复已移除的封面", async () => {
  const pending = pendingCover();
  convert.mockReturnValueOnce(pending.promise);
  const host = mount(imported);
  select(host);
  click(host, "local_playlists.remove_cover");
  pending.resolve(imported);
  await flushSfcHost();
  expect(update).toHaveBeenCalledExactlyOnceWith("");
});
it("关闭弹窗后忽略导入结果和错误", async () => {
  const pending = pendingCover();
  convert.mockReturnValueOnce(pending.promise);
  const host = mount();
  select(host);
  host.close();
  pending.reject(new Error("decode failed"));
  await flushSfcHost();
  expect(update).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(loading).toHaveBeenLastCalledWith(false);
});
it("读取失败保留原封面并允许重试", async () => {
  convert.mockRejectedValueOnce(new Error("decode failed")).mockResolvedValueOnce(imported);
  const host = mount("https://cover.fixture.invalid/old.jpg");
  select(host);
  await flushSfcHost();
  expect(update).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith("local_playlists.invalid_cover");
  select(host);
  await flushSfcHost();
  expect(update).toHaveBeenCalledWith(imported);
});
