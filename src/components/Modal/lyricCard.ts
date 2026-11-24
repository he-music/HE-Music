const cardWidth = 960;
const maxCardHeight = 4096;
const maxTextLength = 12_000;
const padding = 64;
const coverSize = 144;
const coverTimeoutMs = 3000;
const fontFamily = 'system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

const titleStyle = { font: `700 40px ${fontFamily}`, color: "#f8f6f2", height: 58 };
const artistStyle = { font: `28px ${fontFamily}`, color: "#bbb9c9", height: 42 };
const lyricStyle = { font: `600 34px ${fontFamily}`, color: "#f8f6f2", height: 50 };
const variantStyle = { font: `26px ${fontFamily}`, color: "#bbb9c9", height: 40 };

type TextStyle = typeof titleStyle;
interface TextRow {
  text: string;
  style: TextStyle;
  x: number;
  y: number;
}

interface LyricCardContent {
  title: string;
  artist: string;
  lyrics: readonly (readonly string[])[];
  coverUrl?: string;
}

export class LyricCardTooLargeError extends Error {}

function loadCover(url: string, signal: AbortSignal): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    const image = new Image();
    const finish = (loaded: boolean) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      image.onload = null;
      image.onerror = null;
      if (!loaded) image.removeAttribute("src");
      resolve(loaded ? image : undefined);
    };
    const cancel = () => finish(false);
    const timeout = setTimeout(cancel, coverTimeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    image.crossOrigin = "anonymous";
    image.onload = () => finish(true);
    image.onerror = cancel;
    image.src = url;
  });
}

async function readCover(url: string, signal: AbortSignal): Promise<HTMLCanvasElement | undefined> {
  try {
    const image = await loadCover(url, signal);
    if (!image || !image.naturalWidth || !image.naturalHeight) return;
    const cover = document.createElement("canvas");
    cover.width = cover.height = coverSize;
    const ctx = cover.getContext("2d");
    if (!ctx) return;
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const x = (image.naturalWidth - side) / 2;
    const y = (image.naturalHeight - side) / 2;
    ctx.drawImage(image, x, y, side, side, 0, 0, coverSize, coverSize);
    // 只把经过源检查的临时 Canvas 画入成品；封面失败不影响 PNG。
    ctx.getImageData(0, 0, 1, 1);
    return cover;
  } catch {
    return undefined;
  }
}

function* wrapText(text: string, width: number, ctx: CanvasRenderingContext2D) {
  const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : undefined;
  const graphemes = words && new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = function* (value: string, segmenter: Intl.Segmenter | undefined) {
    if (!segmenter) yield* value;
    else for (const { segment } of segmenter.segment(value)) yield segment;
  };
  const fits = (value: string) => ctx.measureText(value).width <= width;
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let row = "";
    for (const word of segments(paragraph, words)) {
      if (fits(row + word)) {
        row += word;
        continue;
      }
      if (row.trim()) yield row.trimEnd();
      row = "";
      const next = word.trimStart();
      if (fits(next)) {
        row = next;
        continue;
      }
      for (const glyph of segments(next, graphemes)) {
        if (!fits(glyph)) throw new LyricCardTooLargeError();
        if (!fits(row + glyph)) {
          yield row;
          row = "";
        }
        row += glyph;
      }
    }
    if (row || !paragraph.trim()) yield row.trimEnd();
  }
}

export async function createLyricCardPng(
  { title, artist, lyrics, coverUrl }: LyricCardContent,
  signal: AbortSignal,
): Promise<Blob> {
  let textLength = title.length + artist.length + lyrics.length;
  if (textLength > maxTextLength) throw new LyricCardTooLargeError();
  for (const line of lyrics) {
    for (const part of line) textLength += part.length;
    if (textLength > maxTextLength) throw new LyricCardTooLargeError();
  }

  const cover = coverUrl ? await readCover(coverUrl, signal) : undefined;
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  const rows: TextRow[] = [];
  let y = padding;
  const append = (text: string, style: TextStyle, x = padding) => {
    ctx.font = style.font;
    for (const row of wrapText(text, cardWidth - padding - x, ctx)) {
      if (y + style.height + padding > maxCardHeight) throw new LyricCardTooLargeError();
      rows.push({ text: row, style, x, y: y + style.height / 2 });
      y += style.height;
    }
  };

  const metadataLeft = cover ? padding + coverSize + 32 : padding;
  append(title, titleStyle, metadataLeft);
  append(artist, artistStyle, metadataLeft);
  if (cover) y = Math.max(y, padding + coverSize);
  y += 40;
  for (const line of lyrics) {
    line.forEach((part, i) => append(part, i === 0 ? lyricStyle : variantStyle));
    y += 20;
  }
  y -= 20;

  if (y + padding > maxCardHeight) throw new LyricCardTooLargeError();
  canvas.width = cardWidth;
  canvas.height = y + padding;
  ctx.fillStyle = "#1e1c2a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (cover) ctx.drawImage(cover, padding, padding);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const row of rows) {
    ctx.font = row.style.font;
    ctx.fillStyle = row.style.color;
    ctx.fillText(row.text, row.x, row.y);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.size) resolve(blob);
      else reject(new Error("PNG encoding failed"));
    }, "image/png");
  });
}

export function lyricCardFilename(title: string): string {
  const safeTitle = Array.from(title.replace(/[/\\:*?"<>|\p{Cc}]/gu, "_").trim())
    .slice(0, 56)
    .join("")
    .replace(/\.+$/, "");
  return safeTitle ? `HE-Music - ${safeTitle}.png` : "HE-Music.png";
}

export function downloadLyricCardPng(blob: Blob, filename: string): void {
  const link = document.createElement("a");
  if (!("download" in link)) throw new Error("Downloads unavailable");
  link.download = filename;
  link.hidden = true;
  const url = URL.createObjectURL(blob);
  link.href = url;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // WebView 可能在 click 返回以后才读取对象 URL。
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
