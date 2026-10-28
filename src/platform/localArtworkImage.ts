import type { Picture } from "./mygo.bindings";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
const JPEG_HEADER_LIMIT = 256 * 1024;

export interface LocalArtworkImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: "image/png" | "image/jpeg";
}

function base64Bytes(data: string): Uint8Array<ArrayBuffer> | undefined {
  if (!data.length || data.length > MAX_BASE64 || data.length % 4 !== 0) return;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const end = data.length - padding;
  if ((data.length / 4) * 3 - padding > MAX_BYTES) return;
  for (let i = 0; i < end; i++) {
    if (alphabet.indexOf(data[i]) === -1) return;
  }
  const last = alphabet.indexOf(data[end - 1]);
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return;
  try {
    const decoded = atob(data);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  } catch {
    return;
  }
}

function dimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16_000_000;
}

function pngHeader(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((byte, i) => bytes[i] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452 &&
    dimensions(view.getUint32(16), view.getUint32(20))
  );
}

function jpegHeader(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const end = Math.min(bytes.length, JPEG_HEADER_LIMIT);
  let offset = 2;
  while (offset < end) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < end && bytes[offset] === 0xff) offset++;
    if (offset >= end) return false;
    const marker = bytes[offset++];
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > end) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > end) return false;
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (length < 8) return false;
      const components = bytes[offset + 7];
      return (
        components > 0 &&
        length === 8 + 3 * components &&
        dimensions(
          bytes[offset + 5] * 256 + bytes[offset + 6],
          bytes[offset + 3] * 256 + bytes[offset + 4],
        )
      );
    }
    offset += length;
  }
  return false;
}

/** 仅做有界 header admission；不执行完整图片解码、CRC 或内容验真。 */
export function admitLocalArtworkImage(
  pictures: readonly Picture[],
): LocalArtworkImage | undefined {
  const count = Math.min(pictures.length, 32);
  for (const front of [true, false]) {
    for (let i = 0; i < count; i++) {
      const picture = pictures[i];
      if ((picture.Type === 3) !== front) continue;
      if (picture.MIME !== "image/png" && picture.MIME !== "image/jpeg") continue;
      const bytes = base64Bytes(picture.Data);
      if (!bytes) continue;
      if (picture.MIME === "image/png" ? pngHeader(bytes) : jpegHeader(bytes)) {
        return { bytes, mime: picture.MIME };
      }
    }
  }
  return undefined;
}
