import type { LocalDownloadResolver } from "@/platform/localDownloadSession";
import { validLocalDownloadFormat } from "@/platform/localDownloadPersistence";

/** Resolve a fresh source without persisting signed URLs or UI state. */
export function createMygoDownloadResolver(
  request: (id: string, platform: string, quality: number, format: string) => Promise<unknown>,
): LocalDownloadResolver {
  return async (quality, source) => {
    try {
      const link = source.links.find((item) => item.name === quality);
      const format = link?.format.toLowerCase();
      if (!link || !format || !validLocalDownloadFormat(format)) throw new Error();
      const response = await request(source.id, source.platform, link.quality, link.format);
      if (!response || typeof response !== "object") throw new Error();
      const url = "url" in response ? response.url : undefined;
      const resolvedFormat = "format" in response ? response.format : undefined;
      if (
        typeof url !== "string" ||
        typeof resolvedFormat !== "string" ||
        resolvedFormat.toLowerCase() !== format
      )
        throw new Error();
      const parsed = new URL(url);
      if (!/^(https?:)$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
        throw new Error();
      return { url, format };
    } catch {
      throw new Error("Download source unavailable");
    }
  };
}
