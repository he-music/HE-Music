import { afterEach, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { emitHostEvent, flushSfcHost, mountProductionSfc } from "@/test/productionSfc";
import { type createLyricCardPng, lyricCardFilename, LyricCardTooLargeError } from "./lyricCard";
import type { FileOperationResult } from "@/platform/filesSession";
import type { LyricCardSaveStatus } from "@/platform/mygo.bindings";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

const line = (text: string, translatedLyric = "", romanLyric = "") => ({
  words: [{ word: text }],
  translatedLyric,
  romanLyric,
});

function mount(mode: "desktop" | "picker" | "download" = "download") {
  const music = reactive({
    playSong: {
      id: "1",
      platform: "test",
      name: "歌曲",
      artists: [{ name: "歌手甲" }, { name: " 歌手乙 " }] as { name: string }[] | string,
    },
    songCover: "https://example.test/cover.jpg",
    songLyric: {
      yrcData: [line("逐字最先", "First", "r1"), line("逐字其次", "Second", "r2")],
      lrcData: [line("普通歌词")],
    },
  });
  const copyData = vi.fn();
  const png = new Blob(["PNG"], { type: "image/png" });
  const createPng = vi.fn<typeof createLyricCardPng>(async () => png);
  const downloadLyricCardPng = vi.fn();
  const target = { name: "selected.png" };
  const pickFile = vi.fn<() => Promise<typeof target | null>>(async () => target);
  const writeFile = vi.fn();
  const saveLyricCard = vi.fn<() => Promise<FileOperationResult<LyricCardSaveStatus>>>(
    async () => ({
      status: "completed",
      value: "saved",
    }),
  );
  const onClose = vi.fn();
  const warning = vi.fn();
  const error = vi.fn();
  const info = vi.fn();
  const success = vi.fn();
  vi.stubGlobal("window", { $message: { warning, error, info, success } });
  const host = mountProductionSfc(
    new URL("./CopyLyrics.vue", import.meta.url),
    {
      "@/stores/music": { useMusicStore: () => music },
      "@/i18n": { t: (key: string) => key },
      "@/utils/helper": { copyData },
      "@/platform": { platform: { kind: mode === "desktop" ? "mygo" : "web" } },
      "@/platform/filesSession": { filesSession: { value: { saveLyricCard } } },
      "./lyricCard": {
        createLyricCardPng: createPng,
        downloadLyricCardPng,
        lyricCardFilename,
        LyricCardTooLargeError,
      },
      "./lyricCardSave": {
        supportsLyricCardPicker: () => mode === "picker",
        pickLyricCardFile: pickFile,
        writeLyricCardFile: writeFile,
        encodeLyricCardPng: async () => "cG5n",
      },
    },
    [
      "NScrollbar",
      "NCheckboxGroup",
      "NCheckbox",
      "NList",
      "NListItem",
      "NFlex",
      "NText",
      "NButton",
    ],
    "",
    { onClose },
  );
  cleanups.push(host.close);
  const all = host.all;
  const find = (tag: string, index = 0) => {
    const match = all().filter((node) => node.tag === tag)[index];
    if (!match) throw new Error(`Missing ${tag}[${index}]`);
    return match;
  };
  const button = (key: string) => {
    const match = all().find(
      (node) => node.tag === "NButton" && all(node).some(({ text }) => text === key),
    );
    if (!match) throw new Error(`Missing button ${key}`);
    return match;
  };
  const select = (indices: number[]) =>
    emitHostEvent(find("NCheckboxGroup"), "onUpdate:value", indices);
  const exportButton = () =>
    button(mode === "download" ? "lyric_card.download_png" : "lyric_card.save_png");
  return {
    host,
    music,
    all,
    find,
    button,
    select,
    exportButton,
    onClose,
    copyData,
    createLyricCardPng: createPng,
    downloadLyricCardPng,
    target,
    pickFile,
    writeFile,
    saveLyricCard,
    png,
    warning,
    error,
    info,
    success,
  };
}

it("exports and copies the same filtered selection in lyric order", async () => {
  const fixture = mount();
  expect(fixture.exportButton().props.disabled).toBe(true);
  fixture.select([1, 0]);
  emitHostEvent(fixture.find("NCheckboxGroup", 1), "onUpdate:value", ["translation"]);
  await flushSfcHost();
  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.createLyricCardPng).toHaveBeenCalledExactlyOnceWith(
    {
      title: "歌曲",
      artist: "歌手甲 / 歌手乙",
      coverUrl: fixture.music.songCover,
      lyrics: [
        ["逐字最先", "First"],
        ["逐字其次", "Second"],
      ],
    },
    expect.any(AbortSignal),
  );
  expect(fixture.downloadLyricCardPng).toHaveBeenCalledExactlyOnceWith(
    fixture.png,
    "HE-Music - 歌曲.png",
  );
  expect(fixture.info).toHaveBeenCalledExactlyOnceWith("lyric_card.download_started");
  expect(fixture.success).not.toHaveBeenCalled();
  expect(fixture.onClose).not.toHaveBeenCalled();
  emitHostEvent(fixture.button("lyric_card.copy"), "onClick");
  await flushSfcHost();
  expect(fixture.copyData).toHaveBeenCalledExactlyOnceWith("逐字最先\nFirst\n\n逐字其次\nSecond");
  expect(fixture.onClose).toHaveBeenCalledOnce();
});

it("guards duplicate exports while pending and cancels delivery when the dialog closes", async () => {
  const fixture = mount();
  let resolvePng: (png: Blob) => void = () => {};
  const pending = new Promise<Blob>((resolve) => {
    resolvePng = resolve;
  });
  fixture.createLyricCardPng.mockReturnValueOnce(pending);
  fixture.select([0]);
  await flushSfcHost();
  emitHostEvent(fixture.exportButton(), "onClick");
  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.exportButton().props.loading).toBe(true);
  expect(fixture.find("NCheckboxGroup").props.disabled).toBe(true);
  expect(fixture.button("lyric_card.copy").props.disabled).toBe(true);
  const call = fixture.createLyricCardPng.mock.calls[0];
  expect(fixture.createLyricCardPng).toHaveBeenCalledOnce();
  fixture.host.close();
  expect(call?.[1].aborted).toBe(true);
  resolvePng(fixture.png);
  await flushSfcHost();
  expect(fixture.downloadLyricCardPng).not.toHaveBeenCalled();
});

it("reports both layout overflow and download initiation failure without losing the selection", async () => {
  const fixture = mount();
  fixture.createLyricCardPng.mockRejectedValueOnce(new LyricCardTooLargeError());
  fixture.downloadLyricCardPng.mockImplementationOnce(() => {
    throw new Error("download blocked");
  });
  fixture.select([0]);
  await flushSfcHost();
  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.warning).toHaveBeenCalledExactlyOnceWith("lyric_card.too_large");
  expect(fixture.exportButton().props.loading).toBe(false);
  expect(fixture.exportButton().props.disabled).toBe(false);
  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.error).toHaveBeenCalledExactlyOnceWith("lyric_card.export_failed");
  expect(fixture.exportButton().props.disabled).toBe(false);
});

it("does not offer the previous song’s lyrics under a new song title", async () => {
  const fixture = mount();
  fixture.select([0]);
  await flushSfcHost();
  fixture.music.playSong = { id: "2", platform: "test", name: "新歌", artists: "单一歌手" };
  await flushSfcHost();
  expect(fixture.exportButton().props.disabled).toBe(true);
  expect(fixture.button("lyric_card.select_all").props.disabled).toBe(true);
  fixture.music.songCover = "/images/song.jpg?asset";
  fixture.music.songLyric = { yrcData: [], lrcData: [line("新歌词")] };
  await flushSfcHost();
  emitHostEvent(fixture.button("lyric_card.select_all"), "onClick");
  await flushSfcHost();
  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.createLyricCardPng).toHaveBeenCalledExactlyOnceWith(
    { title: "新歌", artist: "单一歌手", lyrics: [["新歌词"]], coverUrl: undefined },
    expect.any(AbortSignal),
  );
});

it("opens the browser picker before rendering, and cancellation never falls back to a download", async () => {
  const fixture = mount("picker");
  fixture.pickFile.mockResolvedValueOnce(null);
  fixture.select([0]);
  await flushSfcHost();
  emitHostEvent(fixture.exportButton(), "onClick");
  expect(fixture.pickFile).toHaveBeenCalledExactlyOnceWith("HE-Music - 歌曲.png");
  expect(fixture.createLyricCardPng).not.toHaveBeenCalled();
  await flushSfcHost();
  expect(fixture.downloadLyricCardPng).not.toHaveBeenCalled();
  expect(fixture.success).not.toHaveBeenCalled();
  expect(fixture.error).not.toHaveBeenCalled();

  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.writeFile).toHaveBeenCalledExactlyOnceWith(
    fixture.target,
    fixture.png,
    expect.any(AbortSignal),
  );
  expect(fixture.success).toHaveBeenCalledExactlyOnceWith("lyric_card.saved");
});

it("uses the native save dialog on desktop and reports success only after a save", async () => {
  const fixture = mount("desktop");
  fixture.saveLyricCard.mockResolvedValueOnce({ status: "completed", value: "cancelled" });
  fixture.select([0]);
  await flushSfcHost();
  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.saveLyricCard).toHaveBeenCalledExactlyOnceWith("HE-Music - 歌曲.png", "cG5n");
  expect(fixture.success).not.toHaveBeenCalled();
  expect(fixture.error).not.toHaveBeenCalled();

  emitHostEvent(fixture.exportButton(), "onClick");
  await flushSfcHost();
  expect(fixture.success).toHaveBeenCalledExactlyOnceWith("lyric_card.saved");
  expect(fixture.pickFile).not.toHaveBeenCalled();
  expect(fixture.downloadLyricCardPng).not.toHaveBeenCalled();
});
