import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { File, MediaTypes, Mpeg4IsoAudioSampleEntry } from "node-taglib-sharp";
import { resolve } from "path";

/**
 * 生成文件唯一ID
 * @param filePath 文件路径
 * @returns 唯一ID
 */
export const getFileID = (filePath: string): number => {
  // SHA-256
  const hash = createHash("sha256");
  hash.update(filePath);
  const digest = hash.digest("hex");
  // 将哈希值的前 16 位转换为十进制数字
  const uniqueId = parseInt(digest.substring(0, 16), 16);
  return Number(uniqueId.toString().padStart(16, "0"));
};

/**
 * 生成文件 MD5
 * @param path 文件路径
 * @returns MD5值
 */
export const getFileMD5 = async (path: string): Promise<string> => {
  const data = await readFile(path);
  const hash = createHash("md5");
  hash.update(data);
  return hash.digest("hex");
};

export const parseFile = (path: string) => {
  let songFile: File | null = null;
  try {
    const filePath = resolve(path).replace(/\\/g, "/");
    songFile = File.createFromPath(filePath);
    const { tag, properties } = songFile;
    const codecs = properties.codecs;
    return {
      title: tag.title || "",
      artists: tag.albumArtists.slice() || [],
      album: tag.album || "",
      alia: tag.comment || "",
      // subtitle: tag.subtitle || "",
      duration: Number(properties.durationMilliseconds.toFixed(0)) / 1000 || 0,
      channels: properties.audioChannels,
      codec: codecs?.[0]?.description,
      lossless: codecs?.[0]?.mediaTypes === MediaTypes.LosslessAudio,
      bitsPerSample:
        properties.bitsPerSample || (codecs[0] as Mpeg4IsoAudioSampleEntry)?.audioSampleSize || 16,
      sampleRate: properties.audioSampleRate,
      bitrate: properties.audioBitrate,
      lyrics: tag.lyrics || "",
      pictures: tag.pictures.slice(),
    };
  } finally {
    songFile?.dispose();
  }
};
