<template>
  <div v-if="!status.lyricLoading && (canSearch || hasManual)" class="lyric-empty-actions">
    <button v-if="canSearch" type="button" :disabled="restoring" @click="search">
      <SvgIcon name="Search" :size="18" />
      {{ t("lyricSearch.title") }}
    </button>
    <button v-if="hasManual" type="button" :disabled="restoring" @click="restore">
      {{ t("lyricSearch.restore") }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useStatusStore } from "@/stores";
import { useManualLyricActions } from "@/composables/useManualLyricActions";

const status = useStatusStore();
const { t } = useI18n();
const { canSearch, hasManual, restoring, search, restore } = useManualLyricActions();
</script>

<style scoped lang="scss">
.lyric-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 12px;
  color: rgb(var(--main-cover-color));

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: rgba(var(--main-cover-color), 0.08);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
}
</style>
