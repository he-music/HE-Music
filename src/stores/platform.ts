import { defineStore } from "pinia";
import type { PlatformInfo } from "@/types/main.hemusic";
import { platforms } from "@/api/platform";

interface PlatformData {
  platforms: PlatformInfo[];
  loading: boolean;
}

let loadingPlatforms: Promise<void> | null = null;

export const usePlatformStore = defineStore("platform", {
  state: (): PlatformData => ({
    platforms: [],
    loading: false,
  }),

  getters: {
    featureSupportList(state) {
      return (flag: bigint): PlatformInfo[] =>
        state.platforms.filter((item) => (item.feature_support_flag & flag) !== 0n);
    },

    isFeatureSupport() {
      return (platform: string, flag: bigint): boolean => {
        const platformInfo = this.getPlatformInfo(platform);
        return !!platformInfo && (platformInfo.feature_support_flag & flag) !== 0n;
      };
    },

    getPlatformInfo(state) {
      return (platform: string): PlatformInfo | undefined =>
        state.platforms.find((item) => item.id === platform);
    },
    getPlatformShortName() {
      return (platform: string): string => this.getPlatformInfo(platform)?.shortname || platform;
    },
    getPlatformQualityDescription() {
      return (platform: string, name: string): string =>
        this.getPlatformInfo(platform)?.quality_map?.[name] || undefined;
    },
  },

  actions: {
    async loadPlatforms() {
      if (this.platforms.length) return;
      if (loadingPlatforms) return loadingPlatforms;

      this.loading = true;
      loadingPlatforms = platforms()
        .then((res) => {
          this.platforms = res.list.map((item) => {
            return {
              ...item,
              feature_support_flag: BigInt(item.feature_support_flag),
              quality_map: Object.fromEntries(
                item.qualities.map((item) => [item.name, item.description]),
              ),
            };
          });
        })
        .finally(() => {
          this.loading = false;
          loadingPlatforms = null;
        });

      return loadingPlatforms;
    },
  },
});
