/** 图片导入后作为歌单数据保存，原文件不再参与封面读取。 */
export const localPlaylistCoverAccept = "image/jpeg,image/png,image/gif,image/webp";
const supportedTypes = new Set(localPlaylistCoverAccept.split(","));
const maxFileBytes = 10 * 1024 * 1024;
const maxCoverEdge = 1024;

export async function importLocalPlaylistCover(file: File): Promise<string> {
  if (!supportedTypes.has(file.type) || !file.size || file.size > maxFileBytes) {
    throw new Error("Invalid local playlist cover");
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid cover dimensions");
    const scale = Math.min(1, maxCoverEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cover image conversion unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const cover = canvas.toDataURL("image/jpeg", 0.9);
    if (!cover.startsWith("data:image/jpeg;base64,")) throw new Error("Invalid cover image data");
    return cover;
  } finally {
    URL.revokeObjectURL(url);
  }
}
