import { describe, expect, it, vi } from "vitest";
import { createProtocolNavigationHandler, createShellProtocolSession } from "./shellProtocols";
import type { PlatformProtocols, ProtocolIntent } from "@/platform/protocolSession";

const shell = vi.hoisted(() => ({
  router: {
    isReady: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
  },
  songInfo: vi.fn(),
  usePlayer: vi.fn(),
}));
vi.mock("@/stores", () => ({ useSettingStore: () => ({ registryProtocols: ["kuwo"] }) }));
vi.mock("vue-router", () => ({ useRouter: () => shell.router }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/api/song", () => ({ songInfo: shell.songInfo }));
vi.mock("@/utils/player", () => ({ usePlayer: shell.usePlayer }));

const intent = { epoch: 1, sequence: 1, platform: "kuwo", songId: "3453727" };

function fixture() {
  const router = {
    isReady: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
  };
  const reportFailure = vi.fn();
  const handle = createProtocolNavigationHandler({
    owner: () => 1,
    router,
    reportFailure,
  });
  return { router, reportFailure, handle };
}

describe("shellProtocols navigation", () => {
  it("routes buffered startup and running intents without accessing playback", async () => {
    let send: (event: ProtocolIntent) => void = () => {};
    const stop = vi.fn();
    const provider: PlatformProtocols = {
      begin: async () => ({ epoch: 1 }),
      sync: async () => {
        send({ ...intent, epoch: 2 });
        return {
          epoch: 2,
          results: [{ scheme: "kuwo", selected: true, registered: true, status: "registered" }],
        };
      },
      teardown: vi.fn(async () => {}),
      onIntent: (listener) => {
        send = listener;
        return stop;
      },
    };
    const session = createShellProtocolSession(provider)!;
    try {
      await session.start();
      await vi.waitFor(() => expect(shell.router.push).toHaveBeenCalledTimes(1));
      expect(shell.router.push).toHaveBeenLastCalledWith({
        name: "song",
        query: { platform: "kuwo", id: "3453727" },
      });
      send({ ...intent, epoch: 2, sequence: 2, songId: "123" });
      await vi.waitFor(() => expect(shell.router.push).toHaveBeenCalledTimes(2));
      expect(shell.router.push).toHaveBeenLastCalledWith({
        name: "song",
        query: { platform: "kuwo", id: "123" },
      });
      expect(shell.songInfo).not.toHaveBeenCalled();
      expect(shell.usePlayer).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
    expect(stop).toHaveBeenCalledOnce();
    send({ ...intent, epoch: 2, sequence: 3 });
    expect(shell.router.push).toHaveBeenCalledTimes(2);
  });

  it.each([intent, { ...intent, platform: "netease", songId: "123" }])(
    "opens the song detail route for $platform",
    async (event) => {
      const f = fixture();
      await f.handle(event, () => true);
      expect(f.router.push).toHaveBeenCalledExactlyOnceWith({
        name: "song",
        query: { platform: event.platform, id: event.songId },
      });
      expect(f.reportFailure).not.toHaveBeenCalled();
    },
  );

  it("waits for initial routing before opening a startup intent", async () => {
    const f = fixture();
    let ready!: () => void;
    f.router.isReady.mockImplementation(() => new Promise<void>((resolve) => (ready = resolve)));
    const pending = f.handle(intent, () => true);
    expect(f.router.push).not.toHaveBeenCalled();
    ready();
    await pending;
    expect(f.router.push).toHaveBeenCalledOnce();
  });

  it.each(["owner", "intent"])("ignores navigation after %s expires", async (cause) => {
    let owner: number | undefined = 1;
    let active = true;
    let ready!: () => void;
    const router = {
      isReady: vi.fn(() => new Promise<void>((resolve) => (ready = resolve))),
      push: vi.fn(async () => {}),
    };
    const handle = createProtocolNavigationHandler({
      owner: () => owner,
      router,
      reportFailure: vi.fn(),
    });
    const pending = handle(intent, () => active);
    if (cause === "owner") owner = undefined;
    else active = false;
    ready();
    await pending;
    expect(router.push).not.toHaveBeenCalled();
    await handle(intent, () => active);
    expect(router.isReady).toHaveBeenCalledTimes(1);
  });

  it("reports only a fixed failure signal without sensitive error data", async () => {
    const f = fixture();
    f.router.push.mockRejectedValue(new Error("private URL"));
    await f.handle(intent, () => true);
    expect(f.reportFailure).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not report a navigation failure after the intent expires", async () => {
    const f = fixture();
    let active = true;
    f.router.push.mockImplementation(async () => {
      active = false;
      throw new Error("private URL");
    });
    await f.handle(intent, () => active);
    expect(f.reportFailure).not.toHaveBeenCalled();
  });
});
