import { watch } from "vue";
import type { PreferencesResetFilesOwner } from "@/platform/preferencesResetOwner";
import { afterEach, expect, it, vi } from "vitest";
import { FilesSession, filesSession } from "@/platform/filesSession";
import type { PlatformFiles } from "@/platform/files";

const sessions: FilesSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
});
function session(epoch: number, teardown: (epoch: number) => Promise<void> = async () => {}) {
  const provider: PlatformFiles = {
    begin: async () => ({ epoch }),
    teardown,
    chooseDirectory: vi.fn(),
    defaultDirectory: vi.fn(),
    revokeDirectory: vi.fn(),
    importSettings: vi.fn(),
    exportSettings: vi.fn(),
  };
  const value = new FilesSession(provider);
  sessions.push(value);
  return value;
}

it("captured epoch rejects an owner replaced during native receipt await without disposing the replacement", async () => {
  const old = session(1);
  await old.start();
  const lease = old.capturePreferencesResetOwner();
  expect(lease?.current()).toBe(true);
  const replacement = session(2);
  await replacement.start();
  expect(lease?.current()).toBe(false);
  await expect(lease?.dispose()).rejects.toThrow("owner replaced");
  expect(filesSession.value).toBe(replacement);
  expect(replacement.ready.value).toBe(true);
});

it.each([false, true])(
  "replacement during dispose wait invalidates the captured lease, even if new owner then disposes=%s",
  async (disposeReplacement) => {
    let finish: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const old = session(1, async () => wait);
    await old.start();
    const lease = old.capturePreferencesResetOwner();
    if (!lease) throw new Error("Missing owner lease");
    const closing = lease.dispose();
    const rejected = expect(closing).rejects.toThrow("replaced during disposal");
    const replacement = session(2);
    await replacement.start();
    if (disposeReplacement) await replacement.dispose();
    finish?.();
    await rejected;
    expect(lease.current()).toBe(false);
    if (!disposeReplacement) {
      expect(filesSession.value).toBe(replacement);
      expect(replacement.ready.value).toBe(true);
    }
  },
);

it("an unchanged epoch can drain disposal and proceed; disposed sessions cannot issue a new lease", async () => {
  const old = session(1);
  await old.start();
  const lease = old.capturePreferencesResetOwner();
  if (!lease) throw new Error("Missing owner lease");
  await lease.dispose();
  expect(lease.current()).toBe(true);
  expect(filesSession.value).toBeUndefined();
  expect(old.capturePreferencesResetOwner()).toBeUndefined();
});

it("synchronous settings watcher captures the published generation of its first ready owner", async () => {
  let lease: PreferencesResetFilesOwner | undefined;
  const stop = watch(
    filesSession,
    (owner) => {
      if (!lease) lease = owner?.capturePreferencesResetOwner();
    },
    { flush: "sync", immediate: true },
  );
  try {
    const value = session(1);
    await value.start();
    expect(lease?.current()).toBe(true);
  } finally {
    stop();
  }
});
