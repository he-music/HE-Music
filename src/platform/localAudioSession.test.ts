import { afterEach, describe, expect, it, vi } from "vitest";
import { FilesSession } from "./filesSession";
import { LocalAudioSession } from "./localAudioSession";
import { localFilesSession } from "./localFilesSession";
import type { PlatformFiles } from "./files";
import type { LocalAudioTicket, ScanEntry } from "./mygo.bindings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const ref = { grantToken: "grant", relativePath: "song.mp3", fileId: "file", version: "one" };
const entry: ScanEntry = {
  ref,
  relativePath: ref.relativePath,
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
const ticket = (id: string): LocalAudioTicket => ({
  ticketId: id,
  url: `http://127.0.0.1:12345/${id}`,
  version: ref.version,
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const provider: PlatformFiles = {
    begin: vi.fn(async () => ({ epoch: 4 })),
    chooseDirectory: vi.fn<PlatformFiles["chooseDirectory"]>(async () => ({
      status: "selected",
      grant: { token: "grant", epoch: 4, displayPath: "/fixture" },
      relation: "",
      existingToken: "",
    })),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(async () => {}),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
    teardown: vi.fn(async () => {}),
    startScan: vi.fn(async () => ({ operationId: "job" })),
    readScanPage: vi.fn(async () => ({
      operationId: "job",
      entries: [entry],
      issues: [],
      nextCursor: "1",
      done: true,
    })),
    cancelFileOperation: vi.fn(async () => {}),
    openLocalAudio: vi.fn(async () => ticket("ticket")),
    closeLocalAudio: vi.fn(async () => {}),
  };
  const files = new FilesSession(provider);
  await files.start();
  await files.chooseDirectory();
  await localFilesSession.value?.scan();
  const invalidate = vi.fn();
  const audio = new LocalAudioSession(invalidate);
  cleanups.push(
    () => files.dispose(),
    () => audio.dispose(),
  );
  return { provider, files, invalidate, audio };
}

describe("LocalAudioSession", () => {
  it("opens only the captured ref and immediately invalidates audio on grant revoke", async () => {
    const f = await fixture();
    expect(await f.audio.open(ref)).toBe(ticket("ticket").url);
    expect(f.provider.openLocalAudio).toHaveBeenCalledExactlyOnceWith(4, ref);
    expect(f.audio.active).toBe(true);
    await f.files.revokeDirectory("grant");
    expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.audio.active).toBe(false);
    expect(f.provider.closeLocalAudio).toHaveBeenCalledWith(4, "ticket");
  });

  it("closes a stale URL from an older song without stopping the accepted source", async () => {
    const f = await fixture();
    const old = deferred<LocalAudioTicket>();
    vi.mocked(f.provider.openLocalAudio!).mockReturnValueOnce(old.promise);
    const first = f.audio.open(ref);
    const next = await f.audio.open(ref);
    old.resolve(ticket("late"));
    expect(await first).toBeNull();
    expect(next).toBe(ticket("ticket").url);
    expect(f.audio.active).toBe(true);
    expect(f.provider.closeLocalAudio).toHaveBeenCalledWith(4, "late");
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it("closes malformed and non-loopback ticket results", async () => {
    const f = await fixture();
    for (const url of ["not a url", "https://example.test/ticket"]) {
      vi.mocked(f.provider.openLocalAudio!).mockResolvedValueOnce({ ...ticket("bad"), url });
      await expect(f.audio.open(ref)).rejects.toThrow("Invalid local audio ticket");
      expect(f.provider.closeLocalAudio).toHaveBeenCalledWith(4, "bad");
      expect(f.audio.active).toBe(false);
    }
  });

  it("disposes the pending request and closes its late ticket without resurrection", async () => {
    const f = await fixture();
    const pending = deferred<LocalAudioTicket>();
    vi.mocked(f.provider.openLocalAudio!).mockReturnValueOnce(pending.promise);
    const opening = f.audio.open(ref);
    f.audio.dispose();
    pending.resolve(ticket("late"));
    expect(await opening).toBeNull();
    expect(f.provider.closeLocalAudio).toHaveBeenCalledWith(4, "late");
    expect(f.invalidate).not.toHaveBeenCalled();
  });
  it("closes a pending ticket when a rescan removes its exact file reference", async () => {
    const f = await fixture();
    const pending = deferred<LocalAudioTicket>();
    vi.mocked(f.provider.openLocalAudio!).mockReturnValueOnce(pending.promise);
    const opening = f.audio.open(ref);
    vi.mocked(f.provider.readScanPage!).mockResolvedValueOnce({
      operationId: "job",
      entries: [],
      issues: [],
      nextCursor: "1",
      done: true,
    });
    await localFilesSession.value?.scan();
    pending.resolve(ticket("removed"));
    expect(await opening).toBeNull();
    expect(f.provider.closeLocalAudio).toHaveBeenCalledWith(4, "removed");
    expect(f.audio.active).toBe(false);
  });
});
