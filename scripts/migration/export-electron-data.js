// 在已发布的 Electron 版 HE-Music 开发者工具中执行。只读取原数据，
// 通过浏览器下载保存标准迁移文件；不会修改来源数据库或音乐文件。
void (async () => {
  if (!window.api?.store?.get) throw new Error("请在 Electron 版 HE-Music 中执行此脚本");
  const descriptors = [
    { name: "music-data", store: "music" },
    { name: "user-data", store: "user" },
    { name: "local-data", store: "local" },
    { name: "background-data", store: "background" },
  ];
  const encode = async (value) => {
    if (value instanceof Blob || value instanceof ArrayBuffer) {
      const buffer = value instanceof Blob ? await value.arrayBuffer() : value;
      const bytes = new Uint8Array(buffer);
      const parts = [];
      for (let i = 0; i < bytes.length; i += 8192) {
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
      }
      return {
        kind: value instanceof Blob ? "blob" : "arraybuffer",
        value: btoa(parts.join("")),
        mediaType: value instanceof Blob ? value.type : "",
      };
    }
    return { kind: "json", value: JSON.stringify(value ?? null), mediaType: "" };
  };
  const read = (name, store) =>
    new Promise((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onupgradeneeded = () => opening.transaction.abort();
      opening.onerror = () => reject(new Error("无法读取来源数据库"));
      opening.onsuccess = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains(store)) {
          db.close();
          resolve([]);
          return;
        }
        const transaction = db.transaction(store, "readonly");
        const values = [];
        const cursor = transaction.objectStore(store).openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (typeof item.key !== "string") {
            transaction.abort();
            return;
          }
          values.push([item.key, item.value]);
          item.continue();
        };
        transaction.oncomplete = () => {
          db.close();
          resolve(values);
        };
        transaction.onabort = transaction.onerror = () => {
          db.close();
          reject(new Error("来源数据库读取失败"));
        };
      };
    });
  const available = new Set((await indexedDB.databases()).map((database) => database.name));
  const renderer = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) renderer[key] = localStorage.getItem(key);
  }
  const businessRecords = [];
  for (const { name, store } of descriptors) {
    if (!available.has(name)) continue;
    for (const [key, value] of await read(name, store)) {
      businessRecords.push({ namespace: `${name}/${store}`, key, data: await encode(value) });
    }
  }
  const data = {
    version: "electron-migration-1",
    timestamp: Date.now(),
    renderer,
    businessRecords,
    electron: {
      window: await window.api.store.get("window"),
      lyric: await window.api.store.get("lyric"),
      proxy: await window.api.store.get("proxy"),
    },
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `HE-Music_Electron_Data_${data.timestamp}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
})().catch((error) => console.error("导出迁移数据失败", error));
