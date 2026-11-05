import { mygoGatewayOrigin } from "./gateway";

export interface SongAudioSource {
  readonly url: string;
  readonly key?: string;
  readonly format: string;
}

/** 请求格式保留给音乐平台；下载扩展名与媒体 MIME 使用解密后的容器格式。 */
export function audioOutputFormat(platform: string, format: string): string {
  const normalized = format.toLowerCase();
  if (platform === "kuwo" && normalized === "mflac") return "flac";
  if (platform === "soda" && ["aac", "flac"].includes(normalized)) return "m4a";
  return normalized;
}

/** 无注册表：每次媒体或下载请求携带本机解密所需的参数。 */
export function resolveSongAudioSource(platform: string, source: SongAudioSource): SongAudioSource {
  const gateway = mygoGatewayOrigin();
  if (!gateway || !source.key || !source.url) return source;
  if (!["kuwo", "migu", "soda"].includes(platform)) {
    throw new Error("Unsupported local audio decryption");
  }
  const target = new URL(source.url);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash) {
    throw new Error("Invalid encrypted audio URL");
  }
  const format = audioOutputFormat(platform, source.format);
  const params = new URLSearchParams({ url: target.href, platform, key: source.key, format });
  return { ...source, url: `${gateway}/__audio?${params}`, format };
}
