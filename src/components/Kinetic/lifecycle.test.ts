import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retireKineticScene } from "./lifecycle";

let frames: Map<number, FrameRequestCallback>;
let nextId: number;
function paintFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("kinetic canvas retirement", () => {
  it("detaches immediately and keeps GPU resources until after a paint opportunity", () => {
    let connected = true;
    const canvas = {
      remove: vi.fn(() => {
        connected = false;
      }),
    } as unknown as HTMLCanvasElement;
    const destroy = vi.fn(() => expect(connected).toBe(false));
    retireKineticScene({ destroy }, canvas);
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    paintFrame();
    expect(destroy).not.toHaveBeenCalled();
    paintFrame();
    expect(destroy).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(destroy).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases in a hidden document even if RAF is suspended", () => {
    const destroy = vi.fn();
    retireKineticScene({ destroy });
    vi.advanceTimersByTime(200);
    expect(destroy).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });
  it("does not double-release when the timeout races the second frame", () => {
    const destroy = vi.fn();
    retireKineticScene({ destroy });
    paintFrame();
    const staleFrame = [...frames.values()][0];
    vi.advanceTimersByTime(200);
    staleFrame(0);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("retires successive outgoing scenes without releasing the incoming one", () => {
    const outgoing = Array.from({ length: 4 }, () => ({ destroy: vi.fn() }));
    const incoming = { destroy: vi.fn() };
    outgoing.forEach((scene) => retireKineticScene(scene));
    paintFrame();
    outgoing.forEach((scene) => expect(scene.destroy).not.toHaveBeenCalled());
    paintFrame();
    outgoing.forEach((scene) => expect(scene.destroy).toHaveBeenCalledOnce());
    expect(incoming.destroy).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});
