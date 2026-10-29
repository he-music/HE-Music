import { describe, expect, it, vi } from "vitest";
import type { Info, LocalFileRef, MetadataResult } from "./mygo.bindings";
import { VisibleArtworkCache, type VisibleArtworkTarget } from "./visibleArtworkCache";

const ref: LocalFileRef = {
  grantToken: "grant",
  relativePath: "song.mp3",
  fileId: "song",
  version: "v1",
};
const target: VisibleArtworkTarget = {
  songID: "mygo-local:song",
  platform: "local",
  relativePath: "song.mp3",
  ref,
};

function png(): string {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x4948_4452);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  return Buffer.from(bytes).toString("base64");
}

function result(resultRef = ref): MetadataResult {
  const info: Info = {
    Container: "MP3",
    Title: "",
    Artists: [],
    Album: "",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    Pictures: [{ MIME: "image/png", Type: 3, Description: "", Data: png() }],
    PicturesLoaded: true,
    DurationSeconds: 0,
    BitrateKbps: 0,
    SampleRateHz: 0,
    Channels: 0,
    BitsPerSample: 0,
    Codec: "",
  };
  return { code: "ok", committed: false, ref: { ...resultRef }, info };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("VisibleArtworkCache", () => {
  it("shares pending reads and revokes the URL after the last lease", async () => {
    const read = vi.fn(async () => result());
    const revokeURL = vi.fn();
    const cache = new VisibleArtworkCache({
      read,
      isCurrent: () => true,
      createURL: () => "blob:cover",
      revokeURL,
    });
    const first = cache.acquire(target);
    const second = cache.acquire(target);
    await settle();
    expect(read).toHaveBeenCalledOnce();
    expect(first.url.value).toBe("blob:cover");
    expect(second.url.value).toBe("blob:cover");
    first.release();
    expect(revokeURL).not.toHaveBeenCalled();
    second.release();
    cache.dispose();
    expect(revokeURL).toHaveBeenCalledWith("blob:cover");
  });

  it("rejects a result after the authorization identity changes", async () => {
    let current = true;
    const read = vi.fn(async () => result());
    const cache = new VisibleArtworkCache({
      read,
      isCurrent: () => current,
      createURL: () => "blob:stale",
      revokeURL: vi.fn(),
    });
    const lease = cache.acquire(target);
    current = false;
    await settle();
    expect(lease.url.value).toBeUndefined();
  });

  it("evicts only unleased entries beyond the bound", async () => {
    const read = vi.fn(async (item: VisibleArtworkTarget) => result(item.ref));
    const revokeURL = vi.fn();
    const cache = new VisibleArtworkCache({
      read,
      isCurrent: () => true,
      createURL: () => `blob:${read.mock.calls.length}`,
      revokeURL,
      maxEntries: 1,
    });
    const first = cache.acquire(target);
    await settle();
    const other = { ...target, songID: "mygo-local:other", ref: { ...ref, fileId: "other" } };
    const second = cache.acquire(other);
    await settle();
    expect(first.url.value).toBe("blob:1");
    expect(second.url.value).toBeUndefined();
    expect(revokeURL).not.toHaveBeenCalled();
    first.release();
    expect(revokeURL).toHaveBeenCalledWith("blob:1");
    second.release();
    const retried = cache.acquire(other);
    await settle();
    expect(retried.url.value).toBe("blob:2");
    retried.release();
    cache.dispose();
  });
});
