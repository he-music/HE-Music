<template>
  <n-dropdown trigger="click" :options="options">
    <n-button
      quaternary
      circle
      :title="t('menu.more_operation')"
      :aria-label="t('menu.more_operation')"
    >
      <template #icon><SvgIcon name="Menu" :size="18" /></template>
    </n-button>
  </n-dropdown>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SongInfo } from "@/types/main.hemusic";
import { useSongMenu } from "@/composables/useSongMenu";

const props = defineProps<{ song: SongInfo }>();
const emit = defineEmits<{ removed: [songs: SongInfo[]] }>();
const { t } = useI18n();
const { getMenuOptions } = useSongMenu();
const options = computed(() =>
  getMenuOptions(props.song, -1, undefined, (_event, songs) => emit("removed", songs)),
);
</script>
