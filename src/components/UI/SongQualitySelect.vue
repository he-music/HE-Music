<template>
  <n-select
    v-model:value="value"
    :options="options"
    :render-label="renderLabel"
    :menu-props="{ class: 'song-quality-select-menu' }"
    :disabled="disabled"
    :aria-label="t('common.song_quality')"
  />
</template>

<script setup lang="ts">
import { computed, h } from "vue";
import { NSelect, type SelectOption } from "naive-ui";
import { useI18n } from "vue-i18n";
import { usePlatformStore } from "@/stores";
import type { Link } from "@/types/main.hemusic";
import { formatFileSize } from "@/utils/helper";
import SongQualityLabel from "./SongQualityLabel.vue";

const props = defineProps<{
  platform: string;
  links: readonly Link[];
  disabled?: boolean;
}>();
const value = defineModel<string>("value", { required: true });
const { t } = useI18n();
const platformStore = usePlatformStore();
const options = computed(() =>
  props.links.map((link) => ({
    value: link.name,
    label: platformStore.getPlatformQualityDescription(props.platform, link.name) || link.name,
  })),
);
const renderLabel = (option: SelectOption) => {
  const name = String(option.value ?? "");
  const link = props.links.find((item) => item.name === name);
  const size = Number(link?.size);
  return h(
    SongQualityLabel,
    {
      name,
      description: platformStore.getPlatformQualityDescription(props.platform, name),
    },
    size > 0
      ? { default: () => h("span", { style: { whiteSpace: "nowrap" } }, formatFileSize(size)) }
      : undefined,
  );
};
</script>

<style scoped lang="scss">
:global(.song-quality-select-menu .n-base-select-option__content) {
  flex: 1;
  min-width: 0;
}
</style>
