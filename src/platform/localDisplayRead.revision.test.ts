import { expect, it, vi } from "vitest";
import type { LocalFileRef, MetadataResult } from "@/platform/mygo.bindings";
import { readLocalDisplay } from "./localDisplayRead";

const ref: LocalFileRef = {
  grantToken: "grant",
  relativePath: "song.mp3",
  fileId: "file",
  version: "v1",
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture() {
  const jobs: Array<(result: MetadataResult) => void> = [];
  const read = vi.fn(() => new Promise<MetadataResult>((resolve) => jobs.push(resolve)));
  const owner = { ready: { value: true }, displayAccess: () => ({ current: () => true, read }) };
  const result = (): MetadataResult => ({ code: "ok", committed: false, ref: { ...ref } });
  return { owner, read, jobs, result };
}

it("shares only a matching entry revision and keeps a newer pending read after the old one completes", async () => {
  const h = fixture();
  const oldEntry = {};
  const newEntry = {};
  const old = readLocalDisplay(h.owner, ref, "artwork", oldEntry);
  expect(readLocalDisplay(h.owner, { ...ref }, "artwork", oldEntry)).toBe(old);
  await flush();
  const fresh = readLocalDisplay(h.owner, ref, "artwork", newEntry);
  expect(fresh).not.toBe(old);
  await flush();
  expect(h.read).toHaveBeenCalledTimes(2);
  h.jobs[0](h.result());
  expect(await old).toBeUndefined();
  expect(readLocalDisplay(h.owner, ref, "artwork", newEntry)).toBe(fresh);
  h.jobs[1](h.result());
  expect(await fresh).toEqual(h.result());
});

it("rejects an old revision finishing after the fresh result has already been consumed", async () => {
  const h = fixture();
  const old = readLocalDisplay(h.owner, ref, "artwork", {});
  await flush();
  const fresh = readLocalDisplay(h.owner, ref, "artwork", {});
  await flush();
  h.jobs[1](h.result());
  expect(await fresh).toEqual(h.result());
  h.jobs[0](h.result());
  expect(await old).toBeUndefined();
});

it("retains optional-revision compatibility for existing display consumers", async () => {
  const h = fixture();
  const first = readLocalDisplay(h.owner, ref, "lyrics");
  expect(readLocalDisplay(h.owner, ref, "lyrics")).toBe(first);
  await flush();
  expect(h.read).toHaveBeenCalledOnce();
  h.jobs[0](h.result());
  expect(await first).toEqual(h.result());
});
