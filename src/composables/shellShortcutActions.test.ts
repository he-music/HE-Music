import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShellShortcutActions,
  type ShellShortcutActionDependencies,
} from "./shellShortcutActions";
import { FilesSession, filesSession } from "@/platform/filesSession";
import { localFilesSession, nativeLocalEntry } from "@/platform/localFilesSession";
import { DesktopLyricsSession, desktopLyricsSession } from "@/platform/desktopLyricsSession";
import type { PlatformFiles } from "@/platform/files";
import type { LyricsWindowState, PlatformDesktopLyrics } from "@/platform/desktopLyrics";
import type { ScanEntry } from "@/platform/mygo.bindings";
import type { GlobalShortcutAction } from "@/platform/shortcuts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const entry: ScanEntry = {
  ref: { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "v1" },
  relativePath: "song.mp3",
  filename: "song.mp3",
  size: 20,
  metadata: {
    Container: "MP3",
    Title: "歌曲",
    Artists: [],
    Album: "",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    Pictures: [],
    PicturesLoaded: false,
    DurationSeconds: 1,
    BitrateKbps: 128,
    SampleRateHz: 44100,
    Channels: 2,
    BitsPerSample: 0,
    Codec: "MPEG",
  },
};
async function filesFixture() {
  const entries = [{ ...entry, ref: { ...entry.ref } }];
  const provider: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 4 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 4, displayPath: "/fixture" },
      relation: "",
      existingToken: "",
    })),
    defaultDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    revokeDirectory: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    startScan: vi.fn(async () => ({ operationId: "scan" })),
    readScanPage: vi.fn(async () => ({
      operationId: "scan",
      entries,
      issues: [],
      nextCursor: "1",
      done: true,
    })),
    cancelFileOperation: vi.fn(async () => {}),
    openLocalAudio: vi.fn(),
    closeLocalAudio: vi.fn(async () => {}),
  };
  const session = new FilesSession(provider);
  cleanups.push(() => session.dispose());
  await session.start();
  await session.chooseDirectory();
  await localFilesSession.value?.scan();
  return { session, provider };
}
const state = (revision: number, patch: Partial<LyricsWindowState> = {}): LyricsWindowState => ({
  epoch: 7,
  revision,
  visible: false,
  pending: false,
  locked: false,
  hoverUnlock: false,
  bounds: { x: 0, y: 0, width: 800, height: 180 },
  failure: "",
  ...patch,
});
async function lyricsFixture() {
  const reply = deferred<LyricsWindowState>();
  const provider: PlatformDesktopLyrics = {
    begin: vi.fn(async () => ({ epoch: 7 })),
    publishSnapshot: vi.fn(async () => {}),
    publishClock: vi.fn(async () => {}),
    setVisible: vi.fn(() => reply.promise),
    getState: vi.fn(async () => state(1)),
    teardown: vi.fn(async () => {}),
    attach: vi.fn(),
    close: vi.fn(),
    setBounds: vi.fn(),
    setLocked: vi.fn(),
    command: vi.fn(),
    onWindow: vi.fn(() => () => {}),
    onCommand: vi.fn(() => () => {}),
    onSnapshot: vi.fn(),
    onClock: vi.fn(),
  };
  const clock = () => ({ trackKey: "", playing: false, positionMs: 0, offsetMs: 0, rate: 1 });
  const session = new DesktopLyricsSession(provider, {
    trackKey: () => "",
    snapshotDependencies: () => [],
    clockDependencies: () => [],
    clock,
    snapshot: () => ({
      ...clock(),
      playName: "",
      artistName: "",
      loading: false,
      lrcData: [],
      yrcData: [],
    }),
    onSeek: () => () => {},
    execute: vi.fn(),
  });
  cleanups.push(() => session.dispose());
  await session.start();
  return { session, provider, reply };
}
function fixture() {
  const data: {
    owner: symbol | undefined;
    song: ReturnType<ShellShortcutActionDependencies["song"]>;
  } = {
    owner: Symbol("shell"),
    song: { id: "online" },
  };
  const player = {
    playOrPause: vi.fn(async () => {}),
    nextOrPrev: vi.fn<(direction: "prev" | "next") => Promise<void>>(async () => {}),
    setVolume: vi.fn<(direction: "up" | "down") => void>(() => {}),
  };
  const reportFailure = vi.fn();
  const actions = createShellShortcutActions({
    owner: () => data.owner,
    song: () => data.song,
    files: () => filesSession.value,
    localEntry: nativeLocalEntry,
    lyrics: () => desktopLyricsSession.value,
    player,
    reportFailure,
  });
  cleanups.push(actions.dispose);
  return { actions, data, player, reportFailure };
}
const playback = ["playOrPause", "playPrev", "playNext"] as const;
function expectPlayback(player: ReturnType<typeof fixture>["player"]) {
  expect(player.playOrPause).toHaveBeenCalledTimes(1);
  expect(player.nextOrPrev.mock.calls).toEqual([["prev"], ["next"]]);
}

describe("shellShortcutActions", () => {
  it("preserves online playback and both volume directions", async () => {
    const f = fixture();
    for (const action of [...playback, "volumeUp", "volumeDown"] as const)
      await f.actions.handle(action);
    expectPlayback(f.player);
    expect(f.player.setVolume.mock.calls).toEqual([["up"], ["down"]]);
  });
  it("allows all five actions for registered, authorized native songs without opening audio itself", async () => {
    const files = await filesFixture();
    const f = fixture();
    f.data.song = { id: "mygo-local:file", path: "song.mp3" };
    for (const action of [...playback, "volumeUp", "volumeDown"] as const)
      await f.actions.handle(action);
    expectPlayback(f.player);
    expect(f.player.setVolume.mock.calls).toEqual([["up"], ["down"]]);
    expect(files.provider.openLocalAudio).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { id: "" },
    { id: "fake", path: "/unregistered.mp3" },
    { id: "mygo-local:file" },
  ])("blocks unusable song %j but permits volume", async (song) => {
    const f = fixture();
    f.data.song = song;
    for (const action of playback) await f.actions.handle(action);
    await f.actions.handle("volumeDown");
    expect(f.player.playOrPause).not.toHaveBeenCalled();
    expect(f.player.nextOrPrev).not.toHaveBeenCalled();
    expect(f.player.setVolume).toHaveBeenCalledExactlyOnceWith("down");
  });
  it("rejects a revoked grant at entry and across the dispatch boundary", async () => {
    const files = await filesFixture();
    const f = fixture();
    f.data.song = { id: "mygo-local:file", path: "song.mp3" };
    const revoke = files.session.revokeDirectory("grant");
    const pending = f.actions.handle("playNext");
    await revoke;
    await pending;
    await f.actions.handle("playOrPause");
    expect(f.player.nextOrPrev).not.toHaveBeenCalled();
    expect(f.player.playOrPause).not.toHaveBeenCalled();
  });
  it("rejects ref replacement and files owner replacement before dispatch", async () => {
    const files = await filesFixture();
    const f = fixture();
    f.data.song = { id: "mygo-local:file", path: "song.mp3" };
    const registered = nativeLocalEntry("mygo-local:file");
    if (!registered) throw new Error("missing fixture registration");
    const pending = f.actions.handle("playPrev");
    registered.ref = { ...registered.ref, version: "v2" };
    await pending;
    expect(f.player.nextOrPrev).not.toHaveBeenCalled();
    const retired = f.actions.handle("playNext");
    await files.session.dispose();
    await retired;
    await filesFixture();
    await f.actions.handle("playOrPause");
    expect(f.player.playOrPause).toHaveBeenCalledOnce();
  });
  it.each(["owner", "song", "dispose"] as const)(
    "drops captured actions on %s change",
    async (change) => {
      const f = fixture();
      const pending = f.actions.handle("playNext");
      if (change === "owner") f.data.owner = Symbol("replacement");
      if (change === "song") f.data.song = { id: "other" };
      if (change === "dispose") f.actions.dispose();
      await pending;
      expect(f.player.nextOrPrev).not.toHaveBeenCalled();
    },
  );
  it("requires a Ready shell and ignores unknown actions instead of advancing", async () => {
    const f = fixture();
    // Deliberately exercise the native runtime boundary, whose payload may exceed its static union.
    await f.actions.handle("unknown" as GlobalShortcutAction);
    f.data.owner = undefined;
    await f.actions.handle("volumeUp");
    expect(f.player.nextOrPrev).not.toHaveBeenCalled();
    expect(f.player.setVolume).not.toHaveBeenCalled();
  });
  it("reports current playback failures but suppresses late retired failures", async () => {
    const f = fixture();
    f.player.playOrPause.mockRejectedValueOnce(new Error("playback"));
    await f.actions.handle("playOrPause");
    expect(f.reportFailure).toHaveBeenCalledOnce();
    const late = deferred<void>();
    f.player.playOrPause.mockReturnValueOnce(late.promise);
    const pending = f.actions.handle("playOrPause");
    await flush();
    f.data.owner = Symbol("replacement");
    late.reject(new Error("late"));
    await pending;
    expect(f.reportFailure).toHaveBeenCalledOnce();
  });
  it("requires lyrics ready, works without a song, and waits for native pending/visible receipts", async () => {
    const f = fixture();
    f.data.song = undefined;
    await f.actions.handle("toggleDesktopLyric");
    const lyrics = await lyricsFixture();
    const pending = f.actions.handle("toggleDesktopLyric");
    await flush();
    await f.actions.handle("toggleDesktopLyric");
    expect(lyrics.provider.setVisible).toHaveBeenCalledExactlyOnceWith(7, true);
    expect(lyrics.session.window.value?.visible).toBe(false);
    lyrics.reply.resolve(state(2, { pending: true }));
    await pending;
    expect(lyrics.session.window.value?.pending).toBe(true);
    expect(lyrics.session.window.value?.visible).toBe(false);
    lyrics.session.acceptWindow(state(3, { visible: true }));
    await f.actions.handle("toggleDesktopLyric");
    expect(lyrics.provider.setVisible).toHaveBeenLastCalledWith(7, false);
  });
  it("reports rejected lyric requests without optimistic visibility and releases busy", async () => {
    const lyrics = await lyricsFixture();
    const f = fixture();
    const pending = f.actions.handle("toggleDesktopLyric");
    await flush();
    lyrics.reply.reject(new Error("native rejection"));
    await pending;
    expect(f.reportFailure).toHaveBeenCalledOnce();
    expect(lyrics.session.window.value?.visible).toBe(false);
    await f.actions.handle("toggleDesktopLyric");
    expect(lyrics.provider.setVisible).toHaveBeenCalledTimes(2);
  });
  it.each(["owner", "dispose", "lyrics"] as const)(
    "ignores late lyric failures after %s retirement",
    async (change) => {
      const lyrics = await lyricsFixture();
      const f = fixture();
      const pending = f.actions.handle("toggleDesktopLyric");
      await flush();
      if (change === "owner") f.data.owner = Symbol("new-shell");
      if (change === "dispose") f.actions.dispose();
      if (change === "lyrics") await lyrics.session.dispose();
      lyrics.reply.reject(new Error("late"));
      await pending;
      expect(f.reportFailure).not.toHaveBeenCalled();
    },
  );
  it("does not apply a late native reply to a disposed lyrics owner or its replacement", async () => {
    const lyrics = await lyricsFixture();
    const f = fixture();
    const pending = f.actions.handle("toggleDesktopLyric");
    await flush();
    f.actions.dispose();
    await lyrics.session.dispose();
    const replacement = await lyricsFixture();
    lyrics.reply.resolve(state(9, { visible: true }));
    await pending;
    expect(lyrics.session.window.value?.revision).toBe(1);
    expect(lyrics.session.window.value?.visible).toBe(false);
    expect(replacement.session.window.value?.visible).toBe(false);
  });
  it("rechecks lyric owner before dispatch", async () => {
    const lyrics = await lyricsFixture();
    const f = fixture();
    const pending = f.actions.handle("toggleDesktopLyric");
    await lyrics.session.dispose();
    await pending;
    expect(lyrics.provider.setVisible).not.toHaveBeenCalled();
  });
});
