import { expect, it, vi } from "vitest";
import { LocalFileActions } from "./localFileActions";
import type { LocalFileActionAccess } from "./filesSession";
import type { FileActionResult } from "./mygo.bindings";
import type { SongInfo } from "@/types/main.hemusic";

const song: SongInfo = {
  id: "mygo-local:fixture",
  platform: "local",
  name: "song",
  subtitle: "",
  duration: 1,
  mv_id: "",
  album: "",
  artists: "",
  links: [],
  cover: "",
  path: "song.mp3",
};
function fixture() {
  let current = true;
  let playing = false;
  const onRemoved = vi.fn();
  const access: LocalFileActionAccess = {
    current: () => current,
    reveal: vi.fn(async () => ({ code: "ok", removed: false })),
    remove: vi.fn(async () => ({ code: "ok", removed: true })),
  };
  const controller = new LocalFileActions({
    access: () => access,
    isPlaying: () => playing,
    onRemoved,
  });
  return {
    controller,
    access,
    onRemoved,
    revoke: () => {
      current = false;
    },
    play: () => {
      playing = true;
    },
  };
}

it("refuses a path without current native authority", async () => {
  const native = vi.fn();
  const controller = new LocalFileActions({
    access: native,
    isPlaying: () => false,
    onRemoved: vi.fn(),
  });
  expect(await controller.remove(song)).toEqual({ removed: false, current: false });
  expect(await controller.reveal(song)).toBe(false);
});

it("checks current playback when confirmation is accepted", async () => {
  const f = fixture();
  f.play();
  expect((await f.controller.remove(song)).removed).toBe(false);
  expect(f.access.remove).not.toHaveBeenCalled();
  expect(f.onRemoved).not.toHaveBeenCalled();
});

it("refreshes only after a committed deletion, including revoked after commit", async () => {
  const f = fixture();
  vi.mocked(f.access.remove).mockResolvedValue({ code: "revoked", removed: true });
  expect(await f.controller.remove(song)).toEqual({ removed: true, current: true });
  expect(f.onRemoved).toHaveBeenCalledWith(song);
});

it("preserves a late committed result without changing a replacement session", async () => {
  const f = fixture();
  let finish!: (result: FileActionResult) => void;
  vi.mocked(f.access.remove).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = f.controller.remove(song);
  f.revoke();
  finish({ code: "revoked", removed: true });
  expect(await pending).toEqual({ removed: true, current: false });
  expect(f.onRemoved).not.toHaveBeenCalled();
});

it("does not refresh after a refused or failed deletion", async () => {
  const f = fixture();
  vi.mocked(f.access.remove)
    .mockResolvedValueOnce({ code: "stale", removed: false })
    .mockRejectedValueOnce(new Error("RPC failed"));
  expect((await f.controller.remove(song)).removed).toBe(false);
  expect((await f.controller.remove(song)).removed).toBe(false);
  expect(f.onRemoved).not.toHaveBeenCalled();
});

it("does not turn a committed deletion into a failure if an observer throws", async () => {
  const f = fixture();
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  f.onRemoved.mockImplementation(() => {
    throw new Error("refresh failed");
  });
  try {
    expect(await f.controller.remove(song)).toEqual({ removed: true, current: true });
  } finally {
    output.mockRestore();
  }
});

it("reports reveal dispatch only for the current session", async () => {
  const f = fixture();
  expect(await f.controller.reveal(song)).toBe(true);
  f.revoke();
  expect(await f.controller.reveal(song)).toBe(false);
  expect(f.access.reveal).toHaveBeenCalledTimes(1);
});
