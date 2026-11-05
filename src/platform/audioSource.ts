import { mygoGatewayOrigin } from "./gateway";

export interface SongAudioSource {
  readonly url: string;
  readonly audio_params?: string;
  readonly format: string;
}

/** 请求格式保留给音乐平台；下载扩展名与媒体 MIME 使用解密后的容器格式。 */
export function audioOutputFormat(platform: string, format: string): string {
  const normalized = format.toLowerCase();
  if (platform === "kuwo" && normalized === "mflac") return "flac";
  if (platform === "soda" && ["aac", "flac"].includes(normalized)) return "m4a";
  return normalized;
}

/** 透传主服务准备的执行参数，解密分支不依赖音乐平台。 */
export function resolveSongAudioSource(source: SongAudioSource): SongAudioSource {
  const gateway = mygoGatewayOrigin();
  if (!gateway || !source.url) return source;
  if (!source.audio_params) {
    if ("key" in source && source.key) throw new Error("Audio parameters require a newer server");
    return source;
  }
  if (source.audio_params.length > 16 * 1024 || !/^[A-Za-z0-9_-]+$/.test(source.audio_params)) {
    throw new Error("Invalid audio parameters");
  }
  const target = new URL(source.url);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash) {
    throw new Error("Invalid encrypted audio URL");
  }
  const format = source.format.toLowerCase();
  const params = new URLSearchParams({
    url: target.href,
    audio_params: source.audio_params,
    format,
  });
  return { url: `${gateway}/__audio?${params}`, format };
}
