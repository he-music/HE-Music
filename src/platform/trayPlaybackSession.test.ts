import { expect, it, vi } from "vitest";
import { TrayPlaybackSession, type TrayPlaybackSource } from "./trayPlaybackSession";
import type { TrayPlaybackState, TrayRequest } from "./mygo.bindings";

const source = (track = "A"): TrayPlaybackSource => ({
  trackKey: track,
  hasSong: Boolean(track),
  playing: Boolean(track),
  liked: false,
  canFavorite: Boolean(track),
  canSetMode: Boolean(track),
  playMode: "repeat",
});
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const fixture = () => {
  const syncPlayback = vi.fn<(value: TrayPlaybackState) => Promise<void>>(async () => {});
  const report = vi.fn();
  const session = new TrayPlaybackSession({ syncPlayback }, report);
  const last = () => {
    const value = syncPlayback.mock.calls.at(-1)?.[0];
    if (!value) throw new Error("No snapshot");
    return value;
  };
  const request = (action: TrayRequest["action"] = "next"): TrayRequest => {
    const state = last();
    return { epoch: state.epoch, revision: state.revision, trackKey: state.trackKey, action };
  };
  session.update(source());
  return { session, syncPlayback, report, last, request };
};

it("accepts only the acknowledged latest snapshot and copies false favorite targets", async () => {
  const f = fixture();
  const pending = gate();
  f.syncPlayback.mockImplementationOnce(() => pending.promise);
  const start = f.session.start(7);
  await flush();
  const request = { ...f.request("set-favorite"), favorite: true };
  expect(f.session.capture(request)).toBeUndefined();
  pending.resolve();
  await start;
  const captured = f.session.capture(request);
  request.favorite = false;
  expect(captured?.favorite).toBe(true);
  expect(Object.isFrozen(captured)).toBe(true);
  f.session.update({ ...source(), liked: true });
  await flush();
  expect(f.session.capture({ ...f.request("set-favorite"), favorite: false })?.favorite).toBe(
    false,
  );
});

it("synchronously invalidates A before transport acknowledgement and rejects A→B→A old requests", async () => {
  const f = fixture();
  await f.session.start(8);
  const old = f.request();
  const pending = gate();
  f.syncPlayback.mockImplementationOnce(() => pending.promise);
  f.session.update(source("B"));
  expect(f.session.capture(old)).toBeUndefined();
  await flush();
  f.session.update(source("A"));
  expect(f.session.capture(old)).toBeUndefined();
  pending.resolve();
  await flush();
  expect(f.session.capture(old)).toBeUndefined();
  expect(f.session.capture(f.request())?.trackKey).toBe("A");
  expect(f.last().revision).toBeGreaterThan(old.revision);
});

it("coalesces synchronous state changes and keeps a single transport in flight", async () => {
  const f = fixture();
  await f.session.start(1);
  const pending = gate();
  f.syncPlayback.mockImplementationOnce(() => pending.promise);
  f.session.update(source("B"));
  await flush();
  f.session.update(source("C"));
  f.session.update(source("D"));
  expect(f.syncPlayback).toHaveBeenCalledTimes(2);
  pending.resolve();
  await flush();
  expect(f.syncPlayback).toHaveBeenCalledTimes(3);
  expect(f.last().trackKey).toBe("D");
});

it("validates action-specific capabilities and rejects unknown actions and extra parameters", async () => {
  const f = fixture();
  await f.session.start(1);
  expect(f.session.capture({ ...f.request(), favorite: true })).toBeUndefined();
  expect(f.session.capture(f.request("set-favorite"))).toBeUndefined();
  expect(f.session.capture({ ...f.request("set-favorite"), favorite: false })).toBeUndefined();
  expect(f.session.capture({ ...f.request("set-play-mode"), mode: "shuffle" })?.mode).toBe(
    "shuffle",
  );
  const unknown = f.request();
  Reflect.set(unknown, "action", "unknown");
  expect(f.session.capture(unknown)).toBeUndefined();
  f.session.update({ ...source(), canFavorite: false, canSetMode: false });
  await flush();
  expect(f.session.capture({ ...f.request("set-favorite"), favorite: true })).toBeUndefined();
  expect(f.session.capture({ ...f.request("set-play-mode"), mode: "shuffle" })).toBeUndefined();
});

it("allows settings without a song and requires the exact epoch and revision", async () => {
  const f = fixture();
  f.session.update(source(""));
  await f.session.start(2);
  const settings = f.request("open-settings");
  expect(f.session.capture(settings)?.action).toBe("open-settings");
  expect(f.session.capture(f.request())).toBeUndefined();
  expect(f.session.capture({ ...settings, epoch: 1 })).toBeUndefined();
  expect(f.session.capture({ ...settings, revision: 0 })).toBeUndefined();
  expect(f.session.capture({ ...settings, mode: "repeat" })).toBeUndefined();
});

it("does not let provider mutation or rejected transport grant an accepted identity", async () => {
  const f = fixture();
  f.syncPlayback.mockImplementationOnce(async (value) => {
    value.trackKey = "changed";
  });
  await f.session.start(1);
  expect(f.session.capture(f.request())).toBeUndefined();
  const original: TrayRequest = { epoch: 1, revision: 1, trackKey: "A", action: "next" };
  expect(f.session.capture(original)?.trackKey).toBe("A");
  f.syncPlayback.mockRejectedValueOnce(new Error("fixture transport"));
  f.session.update(source("B"));
  await flush();
  expect(f.report).toHaveBeenCalledOnce();
  expect(f.session.capture(f.request())).toBeUndefined();
  f.session.update(source("C"));
  await flush();
  expect(f.session.capture(f.request())?.trackKey).toBe("C");
});

it("does not resurrect after dispose or accept unsafe epochs", async () => {
  const f = fixture();
  await expect(f.session.start(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow();
  const pending = gate();
  f.syncPlayback.mockImplementationOnce(() => pending.promise);
  const start = f.session.start(1);
  await flush();
  f.session.dispose();
  pending.resolve();
  await start;
  expect(f.session.capture(f.request())).toBeUndefined();
  f.session.update(source("new"));
  await flush();
  expect(f.syncPlayback).toHaveBeenCalledOnce();
});
