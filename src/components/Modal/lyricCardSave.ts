interface SavePickerOptions {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}

const savePickerWindow = () =>
  window as Window & {
    showSaveFilePicker?: (options: SavePickerOptions) => Promise<FileSystemFileHandle>;
  };

export function supportsLyricCardPicker(): boolean {
  return typeof savePickerWindow().showSaveFilePicker === "function";
}

export async function pickLyricCardFile(filename: string): Promise<FileSystemFileHandle | null> {
  const browser = savePickerWindow();
  if (!browser.showSaveFilePicker) throw new Error("Save picker unavailable");
  try {
    // 在用户点击的同一个调用栈中打开，生成图片后再写入。
    return await browser.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "PNG", accept: { "image/png": [".png"] } }],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

export async function writeLyricCardFile(
  target: FileSystemFileHandle,
  png: Blob,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const writer = await target.createWritable();
  try {
    signal.throwIfAborted();
    await writer.write(png);
    signal.throwIfAborted();
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export function encodeLyricCardPng(png: Blob): Promise<string> {
  if (png.size > 16 * 1024 * 1024) throw new Error("Lyric card PNG exceeds the file size limit");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const prefix = "data:image/png;base64,";
      if (typeof reader.result === "string" && reader.result.startsWith(prefix)) {
        resolve(reader.result.slice(prefix.length));
      } else {
        reject(new Error("Invalid lyric card PNG"));
      }
    };
    reader.onerror = () => reject(new Error("Could not read lyric card PNG"));
    reader.readAsDataURL(png);
  });
}
