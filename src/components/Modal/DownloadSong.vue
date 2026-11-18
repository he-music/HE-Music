<template>
  <div class="download-song">
    <n-collapse-transition :show="!song">
      <n-text class="loading">
        {{ t("modal.loading_song_info") }}
      </n-text>
    </n-collapse-transition>
    <n-collapse-transition :show="!!song">
      <n-alert type="warning" :title="t('modal.please_know')" closable>
        {{ t("modal.song_download_warning") }}
      </n-alert>
      <SongDataCard :data="song" />
      <div class="download-field">
        <n-text class="field-label">{{ t("common.song_quality") }}</n-text>
        <SongQualitySelect
          v-model:value="songLevelChosen"
          :platform="song.platform"
          :links="song.links"
          name="level"
        />
      </div>
    </n-collapse-transition>
    <n-flex class="menu" justify="end">
      <n-button strong secondary @click="emit('close')">
        {{ t("common.cancel") }}
      </n-button>
      <n-button :loading="loading" type="primary" @click="download">
        {{ t("common.download_song") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
import downloadManager from "@/utils/downloadManager";

const props = defineProps<{ song: SongInfo }>();
const emit = defineEmits<{ close: [] }>();

// 歌曲数据
// const songData = ref<SongInfo>(props.song);

// 下载数据
const loading = ref<boolean>(false);
const songLevelChosen = ref<string>("320mp3");

if (!props.song.links?.find((item) => item.name === songLevelChosen.value)) {
  songLevelChosen.value = props.song.links?.at(-1)?.name || "";
}

// 下载歌曲
const download = async () => {
  if (!props.song || loading.value) return;
  loading.value = true;
  try {
    const result = await downloadManager.downloadInBrowser(props.song, songLevelChosen.value);
    if (!result.success) {
      window.$message.error(result.message || t("message.download_fail"));
      return;
    }
    emit("close");
  } finally {
    loading.value = false;
  }
};
</script>

<style lang="scss" scoped>
.download-song {
  .n-alert {
    margin-bottom: 20px;
  }
  .download-field {
    margin-top: 20px;
  }
  .field-label {
    display: block;
    margin-bottom: 8px;
  }
  .menu {
    margin-top: 20px;
  }
}
</style>
