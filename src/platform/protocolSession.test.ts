import { describe, expect, it, vi } from "vitest";
import { ProtocolSession, type PlatformProtocols, type ProtocolIntent } from "./protocolSession";

function fixture() {
  let listener: (event: ProtocolIntent) => void = () => {};
  let resolveSync: (() => void) | undefined;
  let epoch = 7;
  const execute = vi.fn<(intent: ProtocolIntent, current: () => boolean) => void>();
  const stop = vi.fn();
  const provider: PlatformProtocols = {
    begin: async () => ({ epoch }),
    sync: vi.fn(async (previous, schemes) => {
      expect(previous).toBe(epoch);
      epoch++;
      listener({ epoch, sequence: epoch, platform: "netease", songId: "123" });
      await new Promise<void>((resolve) => {
        resolveSync = resolve;
      });
      resolveSync = undefined;
      return {
        epoch,
        results: [
          {
            scheme: "orpheus",
            selected: schemes.includes("orpheus"),
            registered: schemes.includes("orpheus"),
            status: schemes.includes("orpheus") ? "registered" : "unregistered",
          },
        ],
      };
    }),
    teardown: vi.fn(async () => {}),
    onIntent: (fn) => {
      listener = fn;
      return stop;
    },
  };
  const session = new ProtocolSession(provider, execute, vi.fn());
  return {
    session,
    execute,
    provider,
    stop,
    send: (event: ProtocolIntent) => listener(event),
    waiting: () => vi.waitFor(() => expect(resolveSync).toBeDefined()),
    ack: () => resolveSync?.(),
  };
}

describe("ProtocolSession", () => {
  it("does not report macOS retained associations as a failure when handling is disabled", async () => {
    const failure = vi.fn();
    const execute = vi.fn();
    let listener: (intent: ProtocolIntent) => void = () => {};
    const provider: PlatformProtocols = {
      begin: async () => ({ epoch: 1 }),
      sync: async () => ({
        epoch: 2,
        results: [{ scheme: "orpheus", selected: false, registered: true, status: "disabled" }],
      }),
      teardown: async () => {},
      onIntent: (fn) => {
        listener = fn;
        return () => {};
      },
    };
    const session = new ProtocolSession(provider, execute, failure);
    await session.start([]);
    listener({ epoch: 2, sequence: 1, platform: "netease", songId: "123" });
    expect(failure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await session.dispose();
  });
  it("retains pre-ACK events and rejects duplicate/old epoch events", async () => {
    const f = fixture();
    const start = f.session.start(["orpheus"]);
    await f.waiting();
    expect(f.execute).not.toHaveBeenCalled();
    f.ack();
    await start;
    expect(f.execute).toHaveBeenCalledTimes(1);
    const first = f.execute.mock.calls[0][1];
    f.send({ epoch: 8, sequence: 8, platform: "netease", songId: "123" });
    f.send({ epoch: 7, sequence: 9, platform: "netease", songId: "123" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.send({ epoch: 8, sequence: 9, platform: "netease", songId: "124" });
    expect(first()).toBe(false);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.session.dispose();
  });
  it("revokes guards on config change and ignores old configuration after reenable", async () => {
    const f = fixture();
    const start = f.session.start(["orpheus"]);
    await f.waiting();
    f.ack();
    await start;
    const current = f.execute.mock.calls[0][1];
    expect(current()).toBe(true);
    const disabled = f.session.sync([]);
    expect(current()).toBe(false);
    await f.waiting();
    f.ack();
    await disabled;
    f.send({ epoch: 9, sequence: 10, platform: "netease", songId: "123" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    const enabled = f.session.sync(["orpheus"]);
    await f.waiting();
    f.ack();
    await enabled;
    expect(f.execute).toHaveBeenCalledTimes(2);
    f.send({ epoch: 8, sequence: 999, platform: "netease", songId: "123" });
    expect(f.execute).toHaveBeenCalledTimes(2);
    await f.session.dispose();
    expect(current()).toBe(false);
  });
  it("disposes immediately while Sync ACK is pending and tears down the returned epoch", async () => {
    const f = fixture();
    const start = f.session.start(["orpheus"]);
    await f.waiting();
    const disposed = f.session.dispose();
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.ack();
    await start;
    await disposed;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.provider.teardown).toHaveBeenCalledWith(8);
  });
  it("bounds the pre-ACK buffer and rejects unselected platforms", async () => {
    const f = fixture();
    const start = f.session.start(["orpheus"]);
    await f.waiting();
    for (let i = 9; i < 50; i++)
      f.send({ epoch: 8, sequence: i, platform: "netease", songId: String(i) });
    f.ack();
    await start;
    expect(f.execute).toHaveBeenCalledTimes(16);
    f.send({ epoch: 8, sequence: 100, platform: "kuwo", songId: "123" });
    expect(f.execute).toHaveBeenCalledTimes(16);
    await f.session.dispose();
  });
});
