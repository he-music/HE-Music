import localforage from "localforage";
import type { StorageValue } from "./mygo.bindings";

export interface ApplicationStorageProvider {
  localSnapshot(): Promise<Record<string, string>>;
  get(namespace: string, key: string): Promise<StorageValue | null>;
  put(namespace: string, key: string, value: StorageValue): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
  clear(namespace: string): Promise<void>;
}

export const applicationDatabases = [
  { name: "music-data", storeName: "music" },
  { name: "user-data", storeName: "user" },
  { name: "local-data", storeName: "local" },
  { name: "local-data", storeName: "local_download_history" },
  { name: "background-data", storeName: "background" },
] as const;

type DatabaseOptions = { name: string; storeName?: string; description?: string };
interface ApplicationDatabase {
  getItem<T = unknown>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

// A failed flush remains retryable. The synchronous Pinia API only updates this
// snapshot; explicit import/reload/quit boundaries await durable native writes.
export class NativeRendererStorage implements Storage {
  private readonly values: Map<string, string>;
  private readonly pending = new Map<string, { value: string | null }>();
  private clearing = false;
  private running?: Promise<void>;

  constructor(
    initial: Record<string, string>,
    private readonly native: ApplicationStorageProvider,
    private readonly report: (error: unknown) => void = (error) =>
      console.error("保存应用数据失败", error),
  ) {
    this.values = new Map(Object.entries(initial));
  }

  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
    this.pending.set(key, { value: String(value) });
    this.schedule();
  }
  removeItem(key: string) {
    this.values.delete(key);
    this.pending.set(key, { value: null });
    this.schedule();
  }
  clear() {
    this.values.clear();
    this.pending.clear();
    this.clearing = true;
    this.schedule();
  }
  private schedule() {
    if (this.running) return;
    const running = Promise.resolve().then(() => this.drain());
    this.running = running;
    void running.then(
      () => {
        this.running = undefined;
        if (this.clearing || this.pending.size) this.schedule();
      },
      (error: unknown) => {
        this.running = undefined;
        this.report(error);
      },
    );
  }
  private async drain() {
    while (this.clearing || this.pending.size) {
      if (this.clearing) {
        // Clear is ordered after any already in-flight put. New values remain in
        // pending and are applied after the clear, even when added during IO.
        this.clearing = false;
        try {
          await this.native.clear("renderer");
        } catch (error) {
          this.clearing = true;
          throw error;
        }
        continue;
      }
      const next = this.pending.entries().next().value;
      if (!next) continue;
      const [key, operation] = next;
      const { value } = operation;
      if (value === null) await this.native.remove("renderer", key);
      else await this.native.put("renderer", key, { kind: "text", value, mediaType: "" });
      if (this.pending.get(key) === operation) this.pending.delete(key);
    }
  }
  async flush(): Promise<void> {
    if (!this.running && (this.clearing || this.pending.size)) this.schedule();
    if (this.running) await this.running;
    if (this.clearing || this.pending.size) await this.flush();
  }
}

let provider: ApplicationStorageProvider | undefined;
let nativeRenderer: NativeRendererStorage | undefined;
interface DeferredDatabaseWrite {
  operation: () => Promise<unknown>;
  namespace: string;
  key: string | null;
}
const failedDatabaseWrites = new Map<string, DeferredDatabaseWrite>();
let databaseWrites: Promise<unknown> = Promise.resolve();

export async function initializeApplicationStorage(
  native: ApplicationStorageProvider,
): Promise<void> {
  const snapshot = await native.localSnapshot();
  for (const key of [
    "setting-store",
    "shortcut-store",
    "data-store",
    "music-store",
    "status-store",
  ]) {
    const value = snapshot[key];
    if (value === undefined) continue;
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid application storage record: ${key}`);
    }
  }
  // Install only after a successful full read. Damaged data blocks boot instead
  // of hydrating defaults and overwriting the user's previous state.
  nativeRenderer = new NativeRendererStorage(snapshot, native);
  provider = native;
}

const browserRendererStorage = () => globalThis.localStorage ?? window.localStorage;

export const applicationStorage: Storage = {
  get length() {
    return (nativeRenderer ?? browserRendererStorage()).length;
  },
  key: (index) => (nativeRenderer ?? browserRendererStorage()).key(index),
  getItem: (key) => (nativeRenderer ?? browserRendererStorage()).getItem(key),
  setItem: (key, value) => (nativeRenderer ?? browserRendererStorage()).setItem(key, value),
  removeItem: (key) => (nativeRenderer ?? browserRendererStorage()).removeItem(key),
  clear: () => (nativeRenderer ?? browserRendererStorage()).clear(),
};

export async function flushApplicationWrites(): Promise<void> {
  await nativeRenderer?.flush();
  await databaseWrites.catch(() => {});
  for (const [identity, write] of [...failedDatabaseWrites]) {
    if (failedDatabaseWrites.get(identity) !== write) continue;
    await databaseOperation(write.operation, write.namespace, write.key, true);
  }
  await databaseWrites;
  if (failedDatabaseWrites.size) throw new Error("Application data writes remain pending");
}

function databaseOperation<T>(
  operation: () => Promise<T>,
  namespace: string,
  mutationKey?: string | null,
  retry = false,
): Promise<T> {
  const identity = JSON.stringify(mutationKey === null ? [namespace] : [namespace, mutationKey]);
  const result = databaseWrites
    .catch(() => {})
    .then(async () => {
      const pending = [...failedDatabaseWrites.values()].some(
        (write) => write.namespace === namespace,
      );
      if (pending && !retry && mutationKey !== null)
        throw new Error("Application data write pending retry");
      if (mutationKey === null && !retry) {
        // Explicit clear supersedes every older deferred write in this database.
        for (const [key, write] of failedDatabaseWrites) {
          if (write.namespace === namespace) failedDatabaseWrites.delete(key);
        }
      }
      return operation();
    });
  databaseWrites = result;
  if (mutationKey !== undefined) {
    void result.then(
      () => {
        failedDatabaseWrites.delete(identity);
      },
      () => {
        failedDatabaseWrites.delete(identity);
        failedDatabaseWrites.set(identity, { operation, namespace, key: mutationKey });
      },
    );
  }
  return result;
}

function binaryString(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  }
  return btoa(chunks.join(""));
}

export async function encodeApplicationValue(value: unknown): Promise<StorageValue> {
  if (value instanceof Blob) {
    return { kind: "blob", value: binaryString(await value.arrayBuffer()), mediaType: value.type };
  }
  if (value instanceof ArrayBuffer) {
    return { kind: "arraybuffer", value: binaryString(value), mediaType: "" };
  }
  const encoded = JSON.stringify(value ?? null);
  if (encoded === undefined) throw new TypeError("Unsupported application storage value");
  return { kind: "json", value: encoded, mediaType: "" };
}

export function decodeApplicationValue(value: StorageValue): unknown {
  if (value.kind === "json") return JSON.parse(value.value);
  if (value.kind === "text") return value.value;
  const buffer = Uint8Array.from(atob(value.value), (character) => character.charCodeAt(0)).buffer;
  if (value.kind === "blob") return new Blob([buffer], { type: value.mediaType });
  if (value.kind === "arraybuffer") return buffer;
  throw new TypeError("Unknown application storage encoding");
}

export function createApplicationDatabase(options: DatabaseOptions): ApplicationDatabase {
  let browser: LocalForage | undefined;
  const web = () => (browser ??= localforage.createInstance(options));
  const namespace = `${options.name}/${options.storeName ?? "keyvaluepairs"}`;
  return {
    getItem: <T>(key: string) => {
      const native = provider;
      if (!native) return web().getItem<T>(key);
      return databaseOperation(async () => {
        const value = await native.get(namespace, key);
        // This is the same typed deserialization boundary as localforage's
        // getItem<T>; domain consumers still validate untrusted persisted input.
        return value === null ? null : (decodeApplicationValue(value) as T);
      }, namespace);
    },
    setItem: <T>(key: string, value: T) => {
      const native = provider;
      if (!native) return web().setItem(key, value);
      return databaseOperation(
        async () => {
          await native.put(namespace, key, await encodeApplicationValue(value));
          return value;
        },
        namespace,
        key,
      );
    },
    keys: () =>
      provider ? databaseOperation(() => provider!.keys(namespace), namespace) : web().keys(),
    removeItem: (key) =>
      provider
        ? databaseOperation(() => provider!.remove(namespace, key), namespace, key)
        : web().removeItem(key),
    clear: () =>
      provider
        ? databaseOperation(() => provider!.clear(namespace), namespace, null)
        : web().clear(),
  };
}

export async function dropApplicationDatabase(options: {
  name: string;
  storeName?: string;
}): Promise<void> {
  if (!provider) return localforage.dropInstance(options);
  const stores = applicationDatabases.filter(
    (store) =>
      store.name === options.name && (!options.storeName || store.storeName === options.storeName),
  );
  if (!stores.length) throw new Error("Unknown application database");
  for (const store of stores) await createApplicationDatabase(store).clear();
}
