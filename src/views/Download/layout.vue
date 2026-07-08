<template>
  <div class="download">
    <div class="title">
      <n-text class="keyword">{{ t("download.download_manager") }}</n-text>
      <n-flex class="status">
        <n-text class="item">
          <SvgIcon name="Music" :depth="3" />
          <n-number-animation :from="0" :to="currentCount" :locale="settingStore.language" />
          {{ t("common.song_count_unit", currentCount) }}
        </n-text>
        <n-text v-if="currentTab === 'download-downloaded'" class="item" depth="3">
          <SvgIcon name="Download" :depth="3" />
          <n-number-animation
            :from="0"
            :to="dataStore.downloadingSongs.length"
            :locale="settingStore.language"
          />
          {{ t("download.downloading") }}
        </n-text>
        <n-text v-else class="item" depth="3">
          <SvgIcon name="DownloadDone" :depth="3" />
          <n-number-animation :from="0" :to="listData.length" /> {{ t("common.completed") }}
        </n-text>
      </n-flex>
    </div>
    <n-flex class="menu" justify="space-between">
      <n-flex class="left" align="flex-end">
        <n-button
          :focusable="false"
          :disabled="currentTab !== 'download-downloaded'"
          type="primary"
          strong
          secondary
          round
          @click="player.updatePlayList(currentListData)"
        >
          <template #icon>
            <SvgIcon name="Play" />
          </template>
          {{ t("common.play") }}
        </n-button>
        <n-button
          :focusable="false"
          :disabled="
            currentTab === 'download-downloaded' ? false : dataStore.downloadingSongs.length === 0
          "
          :loading="loading"
          class="more"
          strong
          secondary
          circle
          @click="
            currentTab === 'download-downloaded'
              ? getDownloadMusic(true)
              : DownloadManager.retryAllDownloads()
          "
        >
          <template #icon>
            <SvgIcon name="Refresh" />
          </template>
        </n-button>
      </n-flex>
      <n-flex class="right" justify="end">
        <n-tabs
          v-model:value="currentTab"
          class="tabs"
          type="segment"
          @update:value="handleTabChange"
        >
          <n-tab name="download-downloaded"> {{ t("common.completed") }} </n-tab>
          <n-tab name="download-downloading"> {{ t("download.downloading") }} </n-tab>
        </n-tabs>
      </n-flex>
    </n-flex>
    <!-- Router View -->
    <RouterView v-slot="{ Component }">
      <Transition :name="`router-${settingStore.routeAnimation}`" mode="out-in">
        <component :is="Component" :data="listData" :loading="loading" class="router-view" />
      </Transition>
    </RouterView>
  </div>
</template>

<script setup lang="ts">
import { useRouter, useRoute } from "vue-router";
import { useSettingStore, useDataStore } from "@/stores";
import { ref, watch, onMounted, onActivated, computed } from "vue";
import { usePlayer } from "@/utils/player";
import type { MessageReactive } from "naive-ui";
import DownloadManager from "@/utils/downloadManager";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const settingStore = useSettingStore();
const dataStore = useDataStore();
const player = usePlayer();

const loading = ref<boolean>(false);
const loadingMsg = ref<MessageReactive | null>(null);
const listData = ref<SongInfo[]>([]);

const currentTab = ref<string>((route.name as string) || "download-downloaded");

// 当前标签页的歌曲列表
const currentListData = computed(() => {
  if (currentTab.value === "download-downloading") {
    return dataStore.downloadingSongs.map((item) => item.song);
  }
  return listData.value;
});

// 当前标签页的歌曲数量
const currentCount = computed(() => {
  if (currentTab.value === "download-downloading") {
    return dataStore.downloadingSongs.length;
  }
  return listData.value.length;
});

const handleTabChange = (name: string) => {
  router.push({ name });
};

watch(
  () => route.name,
  (newName) => {
    if (newName && (newName as string).startsWith("download-")) {
      currentTab.value = newName as string;
      if (newName === "download-downloaded") {
        getDownloadMusic();
      }
    }
  },
);

const getDownloadMusic = async (showTip: boolean = false) => {
  try {
    const path = settingStore.downloadPath;
    if (!path) {
      if (showTip) window.$message.warning(t("message.please_set_download_path"));
      return;
    }

    loading.value = true;
    const result = await DownloadManager.getDownloadedSongs();

    if (result) {
      listData.value = result;
      if (showTip)
        window.$message.success(t("message.found_local_music_count", { count: result.length }));
    } else {
      listData.value = [];
    }
  } catch (error) {
    console.error("获取下载音乐失败:", error);
    window.$message.error("获取下载音乐失败");
  } finally {
    loading.value = false;
    loadingMsg.value?.destroy();
    loadingMsg.value = null;
  }
};

onMounted(() => {
  getDownloadMusic();
});

onActivated(() => {
  if (currentTab.value === "download-downloaded") {
    getDownloadMusic();
  }
});
</script>

<style lang="scss" scoped>
.download {
  display: flex;
  flex-direction: column;
  height: 100%;
  .title {
    display: flex;
    align-items: flex-end;
    line-height: normal;
    margin-top: 12px;
    margin-bottom: 20px;
    height: 40px;
    .keyword {
      font-size: 30px;
      font-weight: bold;
      margin-right: 12px;
      line-height: normal;
    }
    .status {
      font-size: 15px;
      font-weight: normal;
      line-height: 30px;
      .item {
        display: flex;
        align-items: center;
        opacity: 0.9;
        .n-icon {
          margin-right: 4px;
        }
      }
    }
  }
  .menu {
    width: 100%;
    margin-bottom: 20px;
    height: 40px;
    .n-button {
      height: 40px;
      transition: all 0.3s var(--n-bezier);
    }
    .more {
      width: 40px;
    }
    .n-tabs {
      width: 200px;
      --n-tab-border-radius: 25px !important;
      :deep(.n-tabs-rail) {
        outline: 1px solid var(--n-tab-color-segment);
      }
    }
  }
  .router-view {
    flex: 1;
    overflow: hidden;
    max-height: calc((var(--layout-height) - 132) * 1px);
  }
}
</style>
