import { ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import type { MiniPlayerView } from "@/platform/mygo.bindings";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

function mount() {
  const initial: MiniPlayerView = {
    generation: 2,
    revision: 1,
    pinned: false,
    playback: {
      trackKey: "song-a",
      title: "首屏歌曲",
      artist: "歌手",
      artwork: "https://fixture.test/cover.webp",
      language: "zh-CN",
      theme: "dark",
      playing: true,
      canPrevious: false,
      canNext: true,
      favorite: false,
      canFavorite: false,
    },
  };
  let resolveAttach: (view: MiniPlayerView) => void = () => {};
  const attachment = new Promise<MiniPlayerView>((resolve) => (resolveAttach = resolve));
  const offView = vi.fn();
  const rendered = vi.fn<(generation: number) => Promise<void>>().mockResolvedValue(undefined);
  const provider = { attach: () => attachment, onView: () => offView, rendered };
  const host = mountProductionSfc(
    new URL("./index.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key, locale: ref("zh-CN") }) },
      "@/platform/miniPlayer": { mygoMiniPlayer: provider },
    },
    [],
  );
  cleanups.push(host.close);
  return { ...host, initial, rendered, resolveAttach, offView };
}

it("首屏歌曲和控制按钮进入 DOM 后才通知原生显示，不等待网络封面", async () => {
  const host = mount();
  expect(host.rendered).not.toHaveBeenCalled();
  host.rendered.mockImplementation(async (generation) => {
    expect(generation).toBe(2);
    expect(host.all().find((node) => node.tag === "main")?.props["data-theme"]).toBe("dark");
    expect(host.all().find((node) => node.props.class === "title")?.text).toBe("首屏歌曲");
    expect(host.all().some((node) => node.props["aria-label"] === "common.pause")).toBe(true);
    expect(host.all().find((node) => node.tag === "img")?.props.src).toBe(
      host.initial.playback.artwork,
    );
  });
  host.resolveAttach(host.initial);
  await flushSfcHost();
  expect(host.rendered).toHaveBeenCalledOnce();
  await expect(host.rendered.mock.results[0]?.value).resolves.toBeUndefined();
});

it("子页卸载后不再确认迟到的首屏回执", async () => {
  const host = mount();
  host.close();
  host.resolveAttach(host.initial);
  await flushSfcHost();
  expect(host.rendered).not.toHaveBeenCalled();
  expect(host.offView).toHaveBeenCalledOnce();
});
