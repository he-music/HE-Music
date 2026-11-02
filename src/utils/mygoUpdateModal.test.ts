import { afterEach, expect, it, vi } from "vitest";
import { nextTick, type Component, type VNode } from "vue";
import { UpdatesSession } from "@/platform/updatesSession";
import type { PlatformUpdates, UpdatesEvent } from "@/platform/updates";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
import { createMygoUpdatePresenter } from "./mygoUpdateModal";

const sessions: UpdatesSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  vi.unstubAllGlobals();
});
async function owner() {
  const listeners = new Set<(event: UpdatesEvent) => void>();
  const provider: PlatformUpdates = {
    begin: async (requestId) =>
      listeners.forEach((listener) =>
        listener({
          requestId,
          code: "",
          state: {
            epoch: sessions.length + 1,
            operationRevision: 0,
            stateRevision: 1,
            phase: "available",
            code: "",
            version: "2.0.0",
            notes: "",
            date: "",
            downloaded: 0,
            total: 0,
            installBusy: false,
          },
        }),
      ),
    check: async () => {},
    getState: async () => {},
    download: async () => {},
    restart: async () => {},
    install: async () => {},
    teardown: async () => {},
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const session = new UpdatesSession(provider);
  sessions.push(session);
  await session.start();
  return session;
}

it("a pending import from a disposed owner cannot consume the new owner's update prompt", async () => {
  let release!: (module: { default: Component }) => void;
  const component = new Promise<{ default: Component }>((resolve) => {
    release = resolve;
  });
  const open = createMygoUpdatePresenter(() => component);
  const destroyed = vi.fn();
  type Options = { content: () => VNode; onAfterLeave: () => void };
  const create = vi.fn<(options: Options) => { destroy: () => void }>((options) => ({
    destroy: () => {
      destroyed();
      options.onAfterLeave();
    },
  }));
  vi.stubGlobal("window", { $modal: { create } });
  const first = await owner();
  const oldOpening = open(first);
  await first.dispose();
  const second = await owner();
  const newOpening = open(second);
  await open(second);
  expect(create).not.toHaveBeenCalled();
  release({ default: { render: () => null } });
  await Promise.all([oldOpening, newOpening]);
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]?.[0].content().props?.owner).toBe(second);
  await second.dispose();
  await nextTick();
  expect(destroyed).toHaveBeenCalledOnce();
  const third = await owner();
  await open(third);
  expect(create).toHaveBeenCalledTimes(2);
});
