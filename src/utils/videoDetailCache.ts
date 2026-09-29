import type { MVInfo } from "@/types/main.hemusic";

/** 只缓存临近视频的详情，复用在途请求；签名播放地址一分钟后重新获取。 */
export function createVideoDetailCache(
  fetchDetail: (id: string, platform: string) => Promise<MVInfo>,
) {
  const entries = new Map<string, { time: number; promise: Promise<MVInfo> }>();
  const get = (id: string, platform: string) => {
    const key = `${platform}:${id}`;
    const cached = entries.get(key);
    if (cached && Date.now() - cached.time < 60_000) return cached.promise;
    const promise = fetchDetail(id, platform).catch((error: unknown) => {
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw error;
    });
    entries.delete(key);
    entries.set(key, { time: Date.now(), promise });
    while (entries.size > 3) entries.delete(entries.keys().next().value!);
    return promise;
  };
  return { get, clear: () => entries.clear() };
}
