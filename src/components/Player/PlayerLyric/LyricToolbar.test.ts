import { afterEach, expect, it, vi } from "vitest";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

function mount(compact: boolean) {
  const push = vi.fn();
  const openSetting = vi.fn();
  const close = vi.fn();
  const style = vi.fn();
  const status = { showFullPlayer: true, getSongOffset: () => 0 };
  const host = mountProductionSfc(
    new URL("./LyricToolbar.vue", import.meta.url),
    {
      "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
      "@/stores": {
        useMusicStore: () => ({ playSong: { id: 1, platform: "test" } }),
        useStatusStore: () => status,
      },
      "@/utils/modal": { openSetting, openCopyLyrics: vi.fn() },
      "@/router": { default: { push } },
      "../PlayerStylePanel.vue": { default: { render: () => null } },
    },
    ["SvgIcon", "NPopover", "NFlex", "NInputNumber", "NButton"],
    "",
    { compact, onClose: close, onStyle: style },
  );
  cleanups.push(host.close);
  const click = (label: string) => {
    const button = host.all().find((node) => node.props["aria-label"] === label);
    if (!button) throw new Error(`Missing lyric toolbar button: ${label}`);
    emitHostEvent(button, "onClick");
  };
  return { ...host, click, status, push, openSetting, close, style };
}

it("closes the phone/tablet player and routes directly to lyric settings", async () => {
  const host = mount(true);
  host.click("lyricToolbar.settings");
  await flushSfcHost();
  expect(host.close).toHaveBeenCalledOnce();
  expect(host.status.showFullPlayer).toBe(false);
  expect(host.push).toHaveBeenCalledExactlyOnceWith({
    path: "/setting",
    query: { type: "lyrics" },
  });
  expect(host.openSetting).not.toHaveBeenCalled();
});

it("keeps the desktop settings dialog", async () => {
  const host = mount(false);
  host.click("lyricToolbar.settings");
  await flushSfcHost();
  expect(host.status.showFullPlayer).toBe(true);
  expect(host.openSetting).toHaveBeenCalledExactlyOnceWith("lyrics");
  expect(host.push).not.toHaveBeenCalled();
});

it("opens mobile style options in the existing lyric options surface", async () => {
  const host = mount(true);
  host.click("setting.play.style");
  await flushSfcHost();
  expect(host.style).toHaveBeenCalledOnce();
  expect(host.close).not.toHaveBeenCalled();
  expect(host.push).not.toHaveBeenCalled();
  expect(host.all().filter((node) => node.tag === "NPopover")).toHaveLength(1);
});
