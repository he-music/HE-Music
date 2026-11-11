<template>
  <div class="playlist-cover-picker" :aria-busy="importing">
    <n-flex align="center" :wrap="false" :size="16">
      <n-image
        :src="preview"
        fallback-src="/images/album.jpg?asset"
        :width="96"
        :height="96"
        :alt="t('common.cover')"
        object-fit="cover"
        class="preview"
      />
      <n-flex vertical align="start" :size="12">
        <n-button :disabled="disabled" :loading="importing" @click="fileInput?.click()">
          {{ t("local_playlists.choose_cover") }}
        </n-button>
        <n-flex :size="12" :wrap="false">
          <n-button
            text
            :disabled="disabled"
            :aria-expanded="showURL"
            @click="showURL = !showURL"
            >{{ t("local_playlists.cover_link") }}</n-button
          >
          <n-button text :disabled="disabled || !modelValue" @click="clear">
            {{ t("local_playlists.remove_cover") }}
          </n-button>
        </n-flex>
      </n-flex>
    </n-flex>
    <n-input
      v-if="showURL"
      :value="isEmbedded ? '' : modelValue"
      :disabled="disabled"
      :placeholder="t('modal.playlist_cover_url_placeholder')"
      :input-props="{ 'aria-label': t('modal.playlist_cover_url'), autocomplete: 'off' }"
      clearable
      @update:value="updateURL"
    />
    <input
      ref="fileInput"
      type="file"
      :accept="localPlaylistCoverAccept"
      :disabled="disabled"
      :aria-label="t('local_playlists.choose_cover')"
      hidden
      @change="selectImage"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { gatewayProxyUrl } from "@/platform/gateway";
import { importLocalPlaylistCover, localPlaylistCoverAccept } from "@/utils/localPlaylistCover";

const props = defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string]; loading: [value: boolean] }>();
const { t } = useI18n();
const fileInput = ref<HTMLInputElement>();
const importing = ref(false);
const isEmbedded = computed(() => props.modelValue.startsWith("data:image/"));
const preview = computed(() => gatewayProxyUrl(props.modelValue || "/images/album.jpg?asset"));
const showURL = ref(!!props.modelValue && !isEmbedded.value);
let generation = 0;
let active = true;

function cancelImport() {
  generation++;
  importing.value = false;
  emit("loading", false);
}
watch(() => props.modelValue, cancelImport, { flush: "sync" });
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) cancelImport();
  },
);
onScopeDispose(() => {
  active = false;
  cancelImport();
});

function clear() {
  if (props.disabled) return;
  cancelImport();
  showURL.value = false;
  emit("update:modelValue", "");
}
function updateURL(value: string) {
  if (props.disabled) return;
  cancelImport();
  emit("update:modelValue", value);
}
async function selectImage(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = "";
  if (!file || props.disabled) return;
  const request = ++generation;
  importing.value = true;
  emit("loading", true);
  try {
    const cover = await importLocalPlaylistCover(file);
    if (!active || props.disabled || request !== generation) return;
    emit("update:modelValue", cover);
    showURL.value = false;
  } catch {
    if (active && request === generation) window.$message.error(t("local_playlists.invalid_cover"));
  } finally {
    if (request === generation) {
      importing.value = false;
      emit("loading", false);
    }
  }
}
</script>

<style lang="scss" scoped>
.playlist-cover-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-width: 0;
  .preview {
    width: 96px;
    height: 96px;
    flex: 0 0 96px;
    border-radius: 8px;
    overflow: hidden;
  }
}
</style>
