import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
import { parseApplicationBackup } from "./applicationBackup";

it("the released-Electron helper exports real cursor records read-only into an importable backup", async () => {
  const contents: Record<string, { store: string; rows: [string, unknown][] }> = {
    "music-data": { store: "music", rows: [["historyList", [{ id: "song" }]]] },
    "user-data": { store: "user", rows: [["songs", [{ id: "liked" }]]] },
    "background-data": {
      store: "background",
      rows: [["image", new Blob(["image"], { type: "image/png" })]],
    },
  };
  const transactionModes: string[] = [];
  const open = vi.fn((name: string) => {
    const descriptor = contents[name];
    const database = {
      objectStoreNames: { contains: (store: string) => store === descriptor.store },
      close: vi.fn(),
      transaction: (_store: string, mode: string) => {
        transactionModes.push(mode);
        const transaction: {
          oncomplete?: () => void;
          objectStore: () => { openCursor: () => unknown };
        } = {
          objectStore: () => ({
            openCursor: () => {
              let position = 0;
              const request: { onsuccess?: () => void; result: unknown } = { result: null };
              const next = () =>
                queueMicrotask(() => {
                  const row = descriptor.rows[position++];
                  request.result = row ? { key: row[0], value: row[1], continue: next } : null;
                  request.onsuccess?.();
                  if (!row) queueMicrotask(() => transaction.oncomplete?.());
                });
              next();
              return request;
            },
          }),
        };
        return transaction;
      },
    };
    const opening: { onsuccess?: () => void; result: typeof database } = { result: database };
    queueMicrotask(() => opening.onsuccess?.());
    return opening;
  });
  const saved = new Map([
    ["setting-store", "{}"],
    ["data-store", '{"token":"source-account"}'],
  ]);
  let exported: Blob | undefined;
  const click = vi.fn();
  const error = vi.fn();
  const source = readFileSync(
    new URL("../../scripts/migration/export-electron-data.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    window: {
      api: {
        store: {
          get: async (key: string) =>
            key === "window"
              ? { useBorderless: true }
              : key === "lyric"
                ? { config: { showTran: false } }
                : "",
        },
      },
    },
    indexedDB: { databases: async () => Object.keys(contents).map((name) => ({ name })), open },
    localStorage: {
      length: saved.size,
      key: (index: number) => [...saved.keys()][index],
      getItem: (key: string) => saved.get(key),
    },
    document: { createElement: () => ({ click }) },
    URL: {
      createObjectURL: (blob: Blob) => {
        exported = blob;
        return "blob:fixture";
      },
      revokeObjectURL: vi.fn(),
    },
    Blob,
    ArrayBuffer,
    Uint8Array,
    btoa,
    setTimeout: vi.fn(),
    queueMicrotask,
    console: { error },
  });
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(error).not.toHaveBeenCalled();
  expect(transactionModes).toEqual(["readonly", "readonly", "readonly"]);
  expect(open.mock.calls.map(([name]) => name)).not.toContain("local-data");
  if (!exported) throw new Error("missing export");
  const imported = parseApplicationBackup(await exported.text());
  expect(imported.records.find((record) => record.key === "image")?.data.kind).toBe("blob");
  expect(imported.records.find((record) => record.key === "historyList")?.data.value).toContain(
    "song",
  );
  expect(imported.records.find((record) => record.key === "data-store")?.data.value).toContain(
    "source-account",
  );
});
