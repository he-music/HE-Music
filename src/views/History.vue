<template>
  <div class="history">
    <div class="title">
      <n-text class="keyword">
        {{ t("nav.play_history") }}
      </n-text>
      <n-text class="size" depth="3">
        {{ t("common.total_song_count", { count: dataStore.historyList?.length || 0 }) }}
      </n-text>
    </div>
    <n-flex class="menu">
      <n-button
        v-debounce="() => player.updatePlayList(dataStore.historyList)"
        :focusable="false"
        :disabled="!dataStore.historyList?.length"
        type="primary"
        strong
        secondary
        round
      >
        <template #icon>
          <SvgIcon name="Play" />
        </template>
        {{ t("common.play") }}
      </n-button>
      <n-button
        :focusable="false"
        :disabled="!dataStore.historyList?.length"
        class="more"
        strong
        secondary
        round
        @click="cleanHistory"
      >
        <template #icon>
          <SvgIcon name="Delete" />
        </template>
        {{ t("common.clear_list") }}
      </n-button>
    </n-flex>
    <Transition name="fade" mode="out-in">
      <SongList
        v-if="dataStore.historyList.length > 0"
        :data="dataStore.historyList"
        :loading="true"
        hidden-cover
        hidden-size
      />
      <n-empty v-else :description="t('history.no_record')" style="margin-top: 60px" size="large">
        <template #icon>
          <SvgIcon name="SearchOff" />
        </template>
      </n-empty>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { useDataStore } from "@/stores";
import { usePlayer } from "@/utils/player";
import SongList from "@/components/List/SongList.vue";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const player = usePlayer();
const dataStore = useDataStore();

// 清空最近播放
const cleanHistory = () => {
  window.$dialog.warning({
    title: t("common.clear_list"),
    content: t("message.clear_history_confirm"),
    positiveText: t("common.ok"),
    negativeText: t("common.cancel"),
    onPositiveClick: async () => {
      await dataStore.clearHistory();
      window.$message.success(t("message.clear_history_success"));
    },
  });
};
</script>

<style lang="scss" scoped>
.history {
  display: flex;
  flex-direction: column;
  height: 100%;
  .title {
    display: flex;
    align-items: flex-end;
    line-height: normal;
    margin-top: 12px;
    margin-bottom: 20px;
    .keyword {
      font-size: 30px;
      font-weight: bold;
      margin-right: 8px;
      line-height: normal;
    }
    .size {
      font-size: 15px;
      font-weight: normal;
      line-height: 30px;
    }
  }
  .menu {
    width: 100%;
    margin-bottom: 12px;
    .n-button {
      height: 40px;
      transition: all 0.3s var(--n-bezier);
    }
  }
  .song-list {
    flex: 1;
    overflow: hidden;
  }
}
</style>
