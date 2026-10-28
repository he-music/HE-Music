import { describe, expect, it, vi } from "vitest";
import { isProxy, reactive, readonly } from "vue";
import {
  LocalArtworkSession,
  type LocalArtworkTarget,
  type LocalArtworkView,
} from "./localArtworkSession";
import type { Info, MetadataResult } from "./mygo.bindings";

function target(songID = "A"): LocalArtworkTarget {
  return reactive({
    owner: {},
    songID,
    platform: "local",
    relativePath: `${songID}.mp3`,
    ref: { grantToken: "grant", relativePath: `${songID}.mp3`, fileId: songID, version: "v1" },
  });
}

// 合成 PNG IHDR，仅验证 header admission。
function result(t: LocalArtworkTarget): MetadataResult {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  const info: Info = {
    Container: "",
    Title: "",
    Artists: [],
    Album: "",
    AlbumArtists: [],
    Comment: "",
    Lyrics: "",
    PicturesLoaded: true,
    Pictures: [
      { MIME: "image/png", Type: 3, Description: "", Data: Buffer.from(bytes).toString("base64") },
    ],
    DurationSeconds: 0,
    BitrateKbps: 0,
    SampleRateHz: 0,
    Channels: 0,
    BitsPerSample: 0,
    Codec: "",
  };
  return { code: "ok", committed: false, ref: { ...t.ref }, info };
}

function harness() {
  const requests: {
    target: LocalArtworkTarget;
    resolve: (r: MetadataResult | undefined) => void;
    reject: (e: Error) => void;
  }[] = [];
  let granted = true;
  let view: LocalArtworkView | undefined;
  let serial = 0;
  const live = new Set<string>();
  const read = vi.fn(
    (t: LocalArtworkTarget) =>
      new Promise<MetadataResult | undefined>((resolve, reject) => {
        requests.push({ target: t, resolve, reject });
      }),
  );
  const current = vi.fn(() => granted);
  const createURL = vi.fn((bytes: ArrayBuffer, mime: string) => {
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(mime).toBe("image/png");
    const url = `blob:${++serial}`;
    live.add(url);
    return url;
  });
  const revokeURL = vi.fn((url: string) => {
    expect(live.delete(url)).toBe(true);
  });
  const onChange = vi.fn((next: LocalArtworkView | undefined) => {
    view = next;
  });
  const session = new LocalArtworkSession({ read, current, createURL, revokeURL, onChange });
  return {
    session,
    requests,
    read,
    current,
    createURL,
    revokeURL,
    onChange,
    live,
    set granted(value: boolean) {
      granted = value;
    },
    get view() {
      return view;
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
async function accept(h: ReturnType<typeof harness>, t = target()) {
  h.session.update(t);
  const request = h.requests.at(-1)!;
  request.resolve(result(request.target));
  await settle();
  return t;
}

function url(h: ReturnType<typeof harness>, t: LocalArtworkTarget) {
  return h.session.currentURL(t.songID, t.platform, t.relativePath);
}

describe("LocalArtworkSession", () => {
  it("keeps a newer target after currentURL reenters update and denies the old lease", async () => {
    const h = harness();
    const a = await accept(h);
    const b = target("B");
    h.current.mockImplementationOnce(() => {
      h.session.update(b);
      return false;
    });
    expect(url(h, a)).toBeUndefined();
    h.requests[1].resolve(result(h.requests[1].target));
    await settle();
    expect(url(h, b)).toBe("blob:2");
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });
  it("does not replace a newer target when a duplicate update's current callback reenters", async () => {
    const h = harness();
    const a = await accept(h);
    const b = target("B");
    h.current.mockImplementationOnce(() => {
      h.session.update(b);
      return false;
    });
    h.session.update(a);
    h.requests[1].resolve(result(h.requests[1].target));
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(url(h, b)).toBe("blob:2");
    h.session.dispose();
  });
  it("does not clear a new target after the initial admission callback reenters", async () => {
    const h = harness();
    const b = target("B");
    h.current.mockImplementationOnce(() => {
      h.session.update(b);
      return false;
    });
    h.session.update(target());
    expect(h.requests).toHaveLength(1);
    h.requests[0].resolve(result(h.requests[0].target));
    await settle();
    expect(url(h, b)).toBe("blob:1");
    h.session.dispose();
  });
  it("does not cancel a new target when the old load's final current check reenters", async () => {
    const h = harness();
    h.session.update(target());
    const b = target("B");
    let checks = 0;
    h.current.mockImplementation(() => {
      if (++checks === 2) {
        h.session.update(b);
        return false;
      }
      return true;
    });
    h.requests[0].resolve(undefined);
    await settle();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(result(h.requests[1].target));
    await settle();
    expect(url(h, b)).toBe("blob:1");
    h.session.dispose();
  });
  it("copies Vue readonly proxy target/ref, deduplicates and exposes only public view", async () => {
    const h = harness();
    const mutable = target();
    const t = readonly(mutable);
    expect(isProxy(t)).toBe(true);
    expect(isProxy(t.ref)).toBe(true);
    await accept(h, t);
    const captured = h.requests[0].target;
    expect(captured).not.toBe(t);
    expect(captured.ref).not.toBe(t.ref);
    expect(captured.owner).toBe(t.owner);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.ref)).toBe(true);
    h.session.update(t);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.createURL).toHaveBeenCalledTimes(1);
    expect(h.view).toEqual({
      songID: "A",
      platform: "local",
      relativePath: "A.mp3",
      url: "blob:1",
    });
    expect(h.createURL.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
    expect(h.createURL.mock.calls[0][1]).toBe("image/png");
    mutable.ref.version = "changed";
    expect(captured.ref.version).toBe("v1");
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });

  it("captures input before asynchronous read returns", async () => {
    const h = harness();
    const t = target();
    h.session.update(readonly(t));
    const original = result(t);
    t.ref.version = "new";
    Reflect.set(t, "songID", "mutated");
    h.requests[0].resolve(original);
    await settle();
    expect(h.view?.songID).toBe("A");
    expect(h.requests[0].target.ref.version).toBe("v1");
    h.session.dispose();
  });

  it("keeps one real read and only latest pending through A → B → C", async () => {
    const h = harness();
    const a = target();
    const b = target("B");
    const c = target("C");
    h.session.update(a);
    h.session.update(b);
    h.session.update(c);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.requests[0].resolve(result(a));
    await settle();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.requests[1].target.songID).toBe("C");
    expect(h.createURL).not.toHaveBeenCalled();
    h.requests[1].resolve(result(c));
    await settle();
    expect(url(h, c)).toBe("blob:1");
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });

  it("does not revive original A after A → B → A", async () => {
    const h = harness();
    const a = target();
    h.session.update(a);
    h.session.update(target("B"));
    h.session.update(a);
    h.requests[0].resolve(result(a));
    await settle();
    expect(h.createURL).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.requests[1].resolve(result(a));
    await settle();
    expect(url(h, a)).toBe("blob:1");
    h.session.dispose();
  });

  it.each([
    "owner",
    "songID",
    "platform",
    "relativePath",
    "grantToken",
    "refPath",
    "fileId",
    "version",
  ])("invalidates accepted URL when %s changes", async (field) => {
    const h = harness();
    const a = await accept(h);
    const next = { ...a, ref: { ...a.ref } };
    if (field === "owner") next.owner = {};
    else if (field === "songID") next.songID = "new";
    else if (field === "platform") next.platform = "new";
    else if (field === "relativePath") {
      next.relativePath = "new";
      next.ref.relativePath = "new";
    } else if (field === "refPath") next.ref.relativePath = "new";
    else if (field === "grantToken") next.ref.grantToken = "new";
    else if (field === "fileId") next.ref.fileId = "new";
    else next.ref.version = "new";
    h.session.update(next);
    expect(h.revokeURL).toHaveBeenCalledExactlyOnceWith("blob:1");
    expect(url(h, a)).toBeUndefined();
    expect(h.view).toBeUndefined();
    h.session.dispose();
    if (h.requests[1]) h.requests[1].resolve(result(next));
    await settle();
    expect(h.live.size).toBe(0);
  });

  it.each(["grantToken", "relativePath", "fileId", "version"] as const)(
    "rejects returned ref %s conflict",
    async (field) => {
      const h = harness();
      const a = target();
      h.session.update(a);
      const r = result(a);
      r.ref![field] = "different";
      h.requests[0].resolve(r);
      await settle();
      expect(h.createURL).not.toHaveBeenCalled();
      h.session.dispose();
    },
  );

  it.each(["undefined", "code", "ref", "unloaded", "noInfo", "noPictures", "badImage"])(
    "ignores unusable metadata: %s",
    async (kind) => {
      const h = harness();
      const a = target();
      h.session.update(a);
      const r = result(a);
      if (kind === "code") r.code = "failed";
      if (kind === "ref") r.ref = undefined;
      if (kind === "noInfo") r.info = undefined;
      if (kind === "unloaded") r.info!.PicturesLoaded = false;
      if (kind === "noPictures") r.info!.Pictures = [];
      if (kind === "badImage") r.info!.Pictures[0].Data = "AAAA";
      h.requests[0].resolve(kind === "undefined" ? undefined : r);
      await settle();
      expect(h.createURL).not.toHaveBeenCalled();
      h.session.dispose();
    },
  );

  it("checks all public lookup fields and rechecks lease, allowing same target after grant restoration", async () => {
    const h = harness();
    const a = await accept(h);
    expect(h.session.currentURL("B", a.platform, a.relativePath)).toBeUndefined();
    expect(h.session.currentURL(a.songID, "other", a.relativePath)).toBeUndefined();
    expect(h.session.currentURL(a.songID, a.platform, "other")).toBeUndefined();
    h.granted = false;
    expect(url(h, a)).toBeUndefined();
    expect(h.view).toBeUndefined();
    expect(h.revokeURL).toHaveBeenCalledExactlyOnceWith("blob:1");
    h.granted = true;
    await accept(h, a);
    expect(url(h, a)).toBe("blob:2");
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });

  it("drops late result after lease loss, restores same target without concurrent read", async () => {
    const h = harness();
    const a = target();
    h.session.update(a);
    h.granted = false;
    h.session.update(a);
    h.granted = true;
    h.session.update(a);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.requests[0].resolve(result(a));
    await settle();
    expect(h.createURL).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.requests[1].resolve(result(a));
    await settle();
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });

  it("checks lease after read and after URL factory", async () => {
    const h = harness();
    const a = target();
    h.session.update(a);
    h.granted = false;
    h.requests[0].resolve(result(a));
    await settle();
    expect(h.createURL).not.toHaveBeenCalled();
    h.granted = true;
    h.createURL.mockImplementation(() => {
      h.live.add("blob:factory");
      h.granted = false;
      return "blob:factory";
    });
    await accept(h, a);
    expect(h.revokeURL).toHaveBeenCalledExactlyOnceWith("blob:factory");
    expect(h.view).toBeUndefined();
    h.session.dispose();
  });

  it.each(["update", "dispose"])("cleans URL when factory reenters %s", async (action) => {
    const h = harness();
    const b = target("B");
    h.createURL.mockImplementationOnce(() => {
      h.live.add("blob:reentrant");
      if (action === "update") h.session.update(b);
      else h.session.dispose();
      return "blob:reentrant";
    });
    await accept(h);
    expect(h.revokeURL).toHaveBeenCalledExactlyOnceWith("blob:reentrant");
    expect(h.view).toBeUndefined();
    if (action === "update") {
      expect(h.requests[1].target.songID).toBe("B");
      h.requests[1].resolve(result(b));
      await settle();
    }
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });

  it.each(["throw", "https", "data"])("handles URL factory %s", async (mode) => {
    const h = harness();
    h.createURL.mockImplementation(() => {
      if (mode === "throw") throw new Error("private");
      return `${mode}:invalid`;
    });
    await accept(h);
    expect(h.view).toBeUndefined();
    expect(h.revokeURL).not.toHaveBeenCalled();
    h.session.dispose();
  });

  it("contains read/current failures and drains latest pending after rejection", async () => {
    const h = harness();
    const b = target("B");
    h.session.update(target());
    h.session.update(b);
    h.requests[0].reject(new Error("private"));
    await settle();
    expect(h.requests).toHaveLength(2);
    h.requests[1].resolve(result(b));
    await settle();
    h.current.mockImplementation(() => {
      throw new Error("private");
    });
    expect(url(h, b)).toBeUndefined();
    expect(h.live.size).toBe(0);
    h.session.dispose();
  });

  it("contains revoke/onChange throws and still cleans each URL exactly once", async () => {
    const h = harness();
    h.onChange.mockImplementation(() => {
      throw new Error();
    });
    h.revokeURL.mockImplementation((url) => {
      expect(h.live.delete(url)).toBe(true);
      throw new Error();
    });
    await accept(h);
    await accept(h, target("B"));
    h.session.update(undefined);
    h.session.dispose();
    expect(h.revokeURL.mock.calls).toEqual([["blob:1"], ["blob:2"]]);
    expect(h.live.size).toBe(0);
  });

  it("cleans when observer reenters dispose", async () => {
    const h = harness();
    h.onChange.mockImplementation((view) => {
      if (view) h.session.dispose();
    });
    await accept(h);
    expect(h.live.size).toBe(0);
    expect(url(h, target())).toBeUndefined();
    expect(h.revokeURL).toHaveBeenCalledTimes(1);
  });

  it("dispose synchronously clears view, is idempotent and never starts pending IO", async () => {
    const h = harness();
    const a = await accept(h);
    h.session.update(target("B"));
    h.session.update(target("C"));
    h.session.dispose();
    h.session.dispose();
    expect(h.view).toBeUndefined();
    expect(h.live.size).toBe(0);
    expect(url(h, a)).toBeUndefined();
    h.session.update(target("D"));
    h.requests[1].resolve(result(h.requests[1].target));
    await settle();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.createURL).toHaveBeenCalledTimes(1);
  });

  it("undefined clears immediately and waits for old IO before a later target", async () => {
    const h = harness();
    const a = target();
    h.session.update(a);
    h.session.update(undefined);
    h.session.update(target("B"));
    expect(h.read).toHaveBeenCalledTimes(1);
    h.requests[0].resolve(result(a));
    await settle();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.session.dispose();
    h.requests[1].resolve(result(h.requests[1].target));
    await settle();
    expect(h.createURL).not.toHaveBeenCalled();
  });
  it("revoke reentry can dispose without starting replacement IO", async () => {
    const h = harness();
    await accept(h);
    h.revokeURL.mockImplementation((url) => {
      expect(h.live.delete(url)).toBe(true);
      h.session.dispose();
      throw new Error();
    });
    h.session.update(target("B"));
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.view).toBeUndefined();
    expect(h.live.size).toBe(0);
    expect(h.revokeURL).toHaveBeenCalledTimes(1);
  });

  it("revoke reentry preserves the latest target", async () => {
    const h = harness();
    const c = target("C");
    await accept(h);
    h.revokeURL.mockImplementationOnce((url) => {
      expect(h.live.delete(url)).toBe(true);
      h.session.update(c);
    });
    h.session.update(target("B"));
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].target.songID).toBe("C");
    h.requests[1].resolve(result(c));
    await settle();
    expect(url(h, c)).toBe("blob:2");
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });

  it("onChange reentry can update then throw without leaking either URL", async () => {
    const h = harness();
    const b = target("B");
    h.onChange.mockImplementationOnce(() => {
      h.session.update(b);
      throw new Error();
    });
    await accept(h);
    expect(h.requests).toHaveLength(2);
    expect(h.live.size).toBe(0);
    h.requests[1].resolve(result(b));
    await settle();
    expect(url(h, b)).toBe("blob:2");
    h.session.dispose();
    expect(h.revokeURL.mock.calls).toEqual([["blob:1"], ["blob:2"]]);
    expect(h.live.size).toBe(0);
  });

  it("same in-flight target update does not enqueue a duplicate", async () => {
    const h = harness();
    const a = target();
    h.session.update(a);
    h.session.update({ ...a, ref: { ...a.ref } });
    h.requests[0].resolve(result(a));
    await settle();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.createURL).toHaveBeenCalledTimes(1);
    h.session.dispose();
  });

  it("contains synchronous read failure and admits a later target", async () => {
    const h = harness();
    h.read.mockImplementationOnce(() => {
      throw new Error();
    });
    h.session.update(target());
    await accept(h, target("B"));
    expect(h.read).toHaveBeenCalledTimes(2);
    h.session.dispose();
    expect(h.live.size).toBe(0);
  });
});
