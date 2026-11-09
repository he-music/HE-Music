import { defineStore } from "pinia";
import { isAxiosError } from "axios";
import type { PlatformInfo } from "@/types/main.hemusic";
import { platforms } from "@/api/platform";

interface PlatformData {
  platforms: PlatformInfo[];
  loading: boolean;
  loaded: boolean;
  loginRequired: boolean;
  revision: number;
}

const requests = new WeakMap<object, Promise<void>>();

export const usePlatformStore = defineStore("platform", {
  state: (): PlatformData => ({
    platforms: [],
    loading: false,
    loaded: false,
    loginRequired: false,
    revision: 0,
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
    invalidatePlatforms() {
      this.revision++;
      this.platforms = [];
      this.loaded = false;
      this.loginRequired = false;
      this.loading = false;
      requests.delete(this);
    },
    async loadPlatforms() {
      if (this.loaded) return;
      const pending = requests.get(this);
      if (pending) return pending;
      const revision = this.revision;
      this.loading = true;
      const request = platforms()
        .then((res) => {
          if (revision !== this.revision) return;
          this.loaded = true;
          this.loginRequired = false;
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
        .catch((error: unknown) => {
          if (revision !== this.revision) return;
          if (isAxiosError(error) && error.response?.status === 401) {
            this.platforms = [];
            this.loginRequired = true;
            this.loaded = true;
            return;
          }
          throw error;
        })
        .finally(() => {
          if (revision !== this.revision) return;
          this.loading = false;
          requests.delete(this);
        });

      requests.set(this, request);
      return request;
    },
  },
});
