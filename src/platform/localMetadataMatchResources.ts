import { FeatureSupportFlag } from "@/api/platform";
import { songLyric } from "@/api/song";
import type { PlatformInfo } from "@/types/main.hemusic";
import { toLineDownloadLyrics } from "@/utils/downloadLyrics";
import { romaSeparator, transSeparator } from "@/utils/lyric";
import { loadMetadataMatchArtwork } from "./localMetadataMatchArtwork";
import type { MetadataMatchResourceLoader, MetadataMatchResources } from "./localMetadataMatch";

interface MetadataMatchLyricSettings {
  downloadLyric: boolean;
  downloadLyricTran: boolean;
  downloadLyricRoma: boolean;
}
interface MetadataMatchResourceContext {
  platform(id: string): Pick<PlatformInfo, "feature_support_flag" | "image_sizes"> | undefined;
  token(): string;
}

/** 只补取歌词和封面；标签元数据直接使用已选中的搜索结果。 */
export function createMetadataMatchResourceLoader(
  settings: () => MetadataMatchLyricSettings,
  context: MetadataMatchResourceContext,
): MetadataMatchResourceLoader {
  return async (candidate, signal) => {
    const { downloadLyric, downloadLyricTran, downloadLyricRoma } = settings();
    const platform = context.platform(candidate.platform);
    const supports = (flag: bigint) => !!platform && (platform.feature_support_flag & flag) !== 0n;
    const resources: MetadataMatchResources = {};
    if (supports(FeatureSupportFlag.GetSongLyric)) {
      const response = await songLyric(candidate.id, candidate.platform, {
        signal,
        skipErrorMessage: true,
      });
      const original = toLineDownloadLyrics(response.lyric);
      if (original) {
        const translated = toLineDownloadLyrics(response.trans);
        const romanized = toLineDownloadLyrics(response.roma);
        resources.lyrics = [
          original,
          downloadLyric && downloadLyricTran && translated
            ? [transSeparator, translated].join("\n")
            : "",
          downloadLyric && downloadLyricRoma && romanized
            ? [romaSeparator, romanized].join("\n")
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      }
    }
    if (signal.aborted) throw new DOMException("Match cancelled", "AbortError");
    resources.picture = await loadMetadataMatchArtwork(
      candidate,
      platform?.image_sizes ?? [],
      context.token(),
      supports(FeatureSupportFlag.GetSongCover),
      signal,
    );
    return resources;
  };
}
