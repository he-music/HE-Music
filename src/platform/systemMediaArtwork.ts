const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
const MAX_EDGE = 2048;

function abortError(): DOMException {
  return new DOMException("Artwork cancelled", "AbortError");
}

function imageURL(source: string): URL {
  if (source.length > MAX_BASE64 + 32) throw new Error("Artwork source exceeds budget");
  const url = new URL(source, location.origin);
  if (url.username || url.password) throw new Error("Unsupported artwork source");
  if (url.protocol === "http:" || url.protocol === "https:") return url;
  if (url.protocol === "blob:" && url.origin === location.origin) return url;
  if (
    url.protocol === "data:" &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]*={0,2}$/.test(source)
  )
    return url;
  throw new Error("Unsupported artwork source");
}

function mime(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  throw new Error("Unsupported artwork format");
}

function validateDimensions(bytes: Uint8Array, type: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (type === "image/png") {
    if (bytes.length < 24 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
      throw new Error("Invalid artwork dimensions");
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (length < 8) break;
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE)
    throw new Error("Artwork dimensions exceed budget");
}

async function validateImage(blob: Blob, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", cancel);
        image.onload = null;
        image.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(abortError());
      image.onload = () => {
        if (
          image.naturalWidth < 1 ||
          image.naturalHeight < 1 ||
          image.naturalWidth > MAX_EDGE ||
          image.naturalHeight > MAX_EDGE
        )
          finish(new Error("Artwork dimensions exceed budget"));
        else finish();
      };
      image.onerror = () => finish(new Error("Invalid artwork image"));
      signal.addEventListener("abort", cancel, { once: true });
      image.src = url;
    });
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

/** Bounded download; URLs and response details never leave this loader. */
export async function loadSystemMediaArtwork(source: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw abortError();
  const url = imageURL(source);
  const response = await fetch(url.href, {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Artwork unavailable");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    await response.body.cancel();
    throw new Error("Artwork exceeds budget");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Artwork exceeds budget");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (signal.aborted) throw abortError();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const type = mime(bytes);
  validateDimensions(bytes, type);
  await validateImage(new Blob([bytes], { type }), signal);
  if (signal.aborted) throw abortError();
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}
