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
      <n-collapse :default-expanded-names="['level', 'path']" arrow-placement="right">
        <n-collapse-item :title="t('common.song_quality')" name="level">
          <!-- 音质选择 -->
          <n-radio-group v-model:value="songLevelChosen" name="level">
            <n-flex>
              <n-radio v-for="(item, index) in song.links" :key="index" :value="item.name">
                <n-flex>
                  <n-text class="name">
                    {{ getQualityDescription(item.name) }}
                  </n-text>
                  <!-- 文件预估大小 -->
                  <n-text v-if="Number(item.size) > 0" depth="3">
                    {{ formatFileSize(Number(item.size) || 0) }}
                  </n-text>
                </n-flex>
              </n-radio>
            </n-flex>
          </n-radio-group>
        </n-collapse-item>
      </n-collapse>
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
import { usePlatformStore } from "@/stores";
import { formatFileSize } from "@/utils/helper";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
import downloadManager from "@/utils/downloadManager";

const props = defineProps<{ song: SongInfo }>();
const emit = defineEmits<{ close: [] }>();

const platformStore = usePlatformStore();

// 歌曲数据
// const songData = ref<SongInfo>(props.song);

// 下载数据
const loading = ref<boolean>(false);
const songLevelChosen = ref<string>("320mp3");

if (!props.song.links?.find((item) => item.name === songLevelChosen.value)) {
  songLevelChosen.value = props.song.links?.at(-1)?.name || "";
}

const getQualityDescription = (name: string) => {
  const desc = platformStore.getPlatformQualityDescription(props.song?.platform, name);
  return desc ? `${name}(${desc})` : `${name}`;
};

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
  .n-collapse {
    margin-top: 20px;
  }
  .menu {
    margin-top: 20px;
  }
}
</style>
