import { computed, ref } from "vue";
import { useMusicStore, usePlatformStore, useStatusStore } from "@/stores";
import { FeatureSupportFlag } from "@/api/platform";
import { manualLyricKey } from "@/utils/manualLyricRecord";
import { openLyricSearch } from "@/utils/modal";
import lyricManager from "@/utils/lyricManager";
import { usePlayer } from "@/utils/player";
import { t } from "@/i18n";

export const useLyricSearchPlatforms = () => {
  const platforms = usePlatformStore();
  return computed(() =>
    platforms
      .featureSupportList(FeatureSupportFlag.FeatureSupportSearchLyric)
      .filter(
        ({ status, feature_support_flag }) =>
          status === 1 && (feature_support_flag & FeatureSupportFlag.GetLyricInfo) !== 0n,
      ),
  );
};

export function useManualLyricActions() {
  const music = useMusicStore();
  const status = useStatusStore();
  const platforms = useLyricSearchPlatforms();
  const key = computed(() => manualLyricKey(music.playSong));
  const canSearch = computed(() => !!key.value && platforms.value.length > 0);
  const hasManual = computed(() => !!key.value && status.manualLyricTarget === key.value);
  const restoring = ref(false);

  const search = () => {
    if (canSearch.value && !restoring.value) void openLyricSearch(music.playSong);
  };

  const restore = async () => {
    const target = key.value;
    if (!target || !hasManual.value || restoring.value) return;
    restoring.value = true;
    try {
      await lyricManager.restoreDefaultLyric(target);
      if (target === key.value) await usePlayer().reloadTrackLyrics();
    } catch {
      window.$message.error(t("lyricSearch.restoreFailed"));
    } finally {
      restoring.value = false;
    }
  };

  return { canSearch, hasManual, restoring, search, restore };
}
