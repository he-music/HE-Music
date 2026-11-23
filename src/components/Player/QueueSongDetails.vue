<template>
  <div class="index">
    <SvgIcon v-if="playing" :size="20" name="Music" />
    <n-text v-else :class="['num', { big: position > 9999 }]" depth="3">{{ position }}</n-text>
  </div>
  <div class="data">
    <n-text class="name text-hidden">{{ song.name }}</n-text>
    <n-text class="artists text-hidden" depth="3">{{ artists }}</n-text>
  </div>
</template>

<script setup lang="ts">
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";

const props = defineProps<{ song: SongInfo; position: number; playing: boolean }>();
const { t } = useI18n();
const artists = computed(() => {
  const value = props.song.artists;
  return (
    (Array.isArray(value) ? value.map(({ name }) => name).join(" / ") : value) ||
    t("common.unknown_artist")
  );
});
</script>

<style lang="scss" scoped>
.index {
  display: grid;
  place-items: center;
  flex: 0 0 36px;
  margin-right: 12px;

  .big {
    font-size: 12px;
  }
}

.data {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 8px 0;

  .artists {
    font-size: 12px;
  }
}
</style>
