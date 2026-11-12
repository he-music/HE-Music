<template>
  <div v-if="badges.length" :class="['playback-badges', { center }]">
    <n-tooltip v-for="badge in badges" :key="badge.key" :show-arrow="false">
      <template #trigger>
        <span class="playback-badge" tabindex="0" :aria-label="badge.tip">
          <SvgIcon :name="badge.icon" :size="14" aria-hidden="true" />
          <span>{{ badge.label }}</span>
        </span>
      </template>
      <span class="playback-tip">{{ badge.tip }}</span>
    </n-tooltip>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useMusicStore } from "@/stores";
import { activePlaybackEngine, playbackDecryption } from "@/core/audio-player/playbackCapabilities";

defineProps<{ center?: boolean }>();

const { t } = useI18n();
const musicStore = useMusicStore();
const badges = computed(() => {
  if (!musicStore.isHasPlayer) return [];
  const items: { key: string; icon: string; label: string; tip: string }[] = [];
  if (activePlaybackEngine.value === "mpv") {
    items.push({ key: "mpv", icon: "Code", label: "mpv", tip: t("play.mpv_decoder") });
  }
  if (musicStore.isLocalSong) {
    items.push({
      key: "local",
      icon: "FolderMusic",
      label: t("play.local_source"),
      tip: t("play.local_source_tip"),
    });
  } else if (playbackDecryption.value) {
    const key = playbackDecryption.value === "local" ? "local_decryption" : "decryption_service";
    items.push({
      key: "decryption",
      icon: "LockOpen",
      label: t(`play.${key}`),
      tip: t(`play.${key}_tip`),
    });
  }
  return items;
});
</script>

<style lang="scss" scoped>
.playback-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
  &.center {
    justify-content: center;
  }
  .playback-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    border-radius: 6px;
    color: rgba(var(--main-cover-color), 0.75);
    background-color: rgba(var(--main-cover-color), 0.08);
    font-size: 11px;
    line-height: 16px;
    cursor: default;
    &:focus-visible {
      outline: 1px solid currentColor;
      outline-offset: 2px;
    }
  }
}
.playback-tip {
  color: rgb(var(--main-cover-color));
}
</style>
