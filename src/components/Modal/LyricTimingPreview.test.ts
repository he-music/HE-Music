import { afterEach, expect, it, vi } from "vitest";
import { h, reactive, ref, shallowRef } from "vue";
import { flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import { useLyricPlaybackClock } from "@/components/LyricStage/useLyricPlaybackClock";
import type { SongLyric } from "@/types/lyric";
import { parseSongLyric } from "@/utils/lyric";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

function mount(initial: SongLyric) {
  const lyrics = shallowRef(initial);
  const position = ref(5000);
  const status = reactive({ playStatus: false, getSongOffset: vi.fn(() => 10_000) });
  const audio = { on: vi.fn<(event: string, sample: () => void) => void>(), off: vi.fn() };
  const player = { getSeek: () => position.value, setSeek: vi.fn(), play: vi.fn() };
  const host = mountProductionSfc(
    new URL("./LyricTimingPreview.vue", import.meta.url),
    {
      "@vueuse/core": { useDocumentVisibility: () => ref("visible") },
      "@/stores/status": { useStatusStore: () => status },
      "@/utils/player": { usePlayer: () => player },
      "@/utils/audioManager": { default: audio },
      "@/components/LyricStage/useLyricPlaybackClock": { useLyricPlaybackClock },
      "@/components/Player/PlayerLyric/DefaultLyric.vue": {
        default: { render: () => h("default-lyric") },
      },
    },
    [],
    "",
    () => ({ lyrics: lyrics.value, trackKey: "target", visible: true }),
  );
  cleanups.push(host.close);
  return { ...host, lyrics, position, status, audio, player };
}

it("候选固定复用普通效果，换词保持真实播放时钟，不应用旧歌词偏移或跳播", async () => {
  const a = parseSongLyric({
    lyric: "[00:01.00]<0,250>甲<250,500>一\n[00:04.00]甲二",
    trans: "[00:01.00]译文",
    roma: "[00:01.00]罗马音",
  });
  const b = parseSongLyric({ lyric: "[00:01.00]乙一\n[00:08.00]乙二" });
  const host = mount(a);
  const initial = host.all().find((node) => node.tag === "default-lyric");
  expect(initial?.props["candidate-preview"]).toBe("");
  expect(initial?.props.preview).toEqual({ lyrics: a, playing: false });
  const clock = initial?.props.clock;
  expect(clock).toEqual({ time: expect.objectContaining({ value: 5000 }) });

  host.lyrics.value = b;
  await flushSfcHost();
  const updated = host.all().find((node) => node.tag === "default-lyric");
  expect(updated).toBe(initial);
  expect(updated?.props.clock).toBe(clock);
  expect(updated?.props.preview).toEqual({ lyrics: b, playing: false });
  expect(host.status.getSongOffset).not.toHaveBeenCalled();
  expect(host.player.setSeek).not.toHaveBeenCalled();
  expect(host.player.play).not.toHaveBeenCalled();

  const seek = host.audio.on.mock.calls.find(([event]) => event === "seeked")?.[1];
  expect(seek).toBeTypeOf("function");
  host.position.value = 8100;
  seek?.();
  expect(clock).toEqual({ time: expect.objectContaining({ value: 8100 }) });
  host.close();
  expect(host.audio.off).toHaveBeenCalledWith("seeked", seek);
  expect(host.audio.off).toHaveBeenCalledWith("loadedmetadata", seek);
});
