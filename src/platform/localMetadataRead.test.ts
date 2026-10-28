import { expect, it, vi } from "vitest";
import { readLocalMetadata } from "./localMetadataRead";
import type { LocalFileRef, MetadataResult } from "./mygo.bindings";

const ref = (): LocalFileRef => ({
  grantToken: "grant",
  relativePath: "song.mp3",
  fileId: "file",
  version: "v1",
});
const gate = () => {
  let resolve!: (result: MetadataResult | undefined) => void;
  const promise = new Promise<MetadataResult | undefined>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

it("shares only a pending read of the captured complete ref and retires the result after settlement", async () => {
  const pending = gate();
  const read = vi.fn<(ref: LocalFileRef) => Promise<MetadataResult | undefined>>(
    () => pending.promise,
  );
  const owner = { metadata: { read } };
  const source = ref();
  const first = readLocalMetadata(owner, source);
  const second = readLocalMetadata(owner, { ...source });
  source.version = "changed";
  await Promise.resolve();
  expect(first).toBe(second);
  expect(read).toHaveBeenCalledExactlyOnceWith(ref());
  pending.resolve({ code: "ok", ref: ref(), committed: false });
  await first;
  const later = readLocalMetadata(owner, ref());
  expect(later).not.toBe(first);
  await later;
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not share across owners, grants, paths or versions", async () => {
  const pending = gate();
  const read = vi.fn(() => pending.promise);
  const owner = { metadata: { read } };
  const values = [
    readLocalMetadata(owner, ref()),
    readLocalMetadata({ metadata: { read } }, ref()),
    readLocalMetadata(owner, { ...ref(), grantToken: "other" }),
    readLocalMetadata(owner, { ...ref(), relativePath: "other.mp3" }),
    readLocalMetadata(owner, { ...ref(), version: "other" }),
  ];
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(5);
  pending.resolve(undefined);
  await Promise.all(values);
});

it("retires rejected reads and safely handles owners without metadata support", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("fixture")).mockResolvedValue(undefined);
  const owner = { metadata: { read } };
  await expect(readLocalMetadata(owner, ref())).rejects.toThrow("fixture");
  await expect(readLocalMetadata(owner, ref())).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(2);
  await expect(readLocalMetadata({}, ref())).resolves.toBeUndefined();
});
