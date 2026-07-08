<template>
  <div class="comment">
    <n-flex :wrap="false" align="center" class="song-data">
      <n-image
        :src="commentData.cover || '/images/song.jpg?asset'"
        :alt="commentData.cover || '/images/song.jpg?asset'"
        class="cover-img"
        preview-disabled
        @load="coverLoaded"
      >
        <template #placeholder>
          <div class="cover-loading">
            <img src="/images/song.jpg?asset" class="loading-img" alt="loading-img" />
          </div>
        </template>
      </n-image>
      <n-flex :size="2" class="song-info" vertical>
        <span class="title text-hidden">{{ commentData.name }}</span>
        <span class="artist text-hidden">
          {{ commentData.creator }}
        </span>
      </n-flex>
      <n-flex
        v-if="commentData.id && commentData.resource_type !== 'song'"
        class="close"
        align="center"
        justify="center"
        @click="openCommentTarget"
      >
        <SvgIcon name="Link" :size="24" />
      </n-flex>
    </n-flex>
    <div v-if="commentData.id" class="content">
      <n-tabs v-model:value="tab" class="tabs" type="line" animated>
        <n-tab-pane
          v-for="tab in tabs"
          :key="`comment-${tab.value}`"
          :tab="tab.name"
          :name="tab.value"
          display-directive="show:lazy"
        >
          <CommentResult
            :type="tab.value"
            :id="commentData.id"
            :platform="commentData.platform"
            :resource_type="commentData.resource_type"
          />
        </n-tab-pane>
      </n-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMusicStore, useStatusStore } from "@/stores";
import CommentResult from "@/views/Comment/CommentResult.vue";
import { coverLoaded } from "@/utils/helper";
import { CommentConfig } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";

const { t } = useI18n();
const router = useRouter();

const musicStore = useMusicStore();
const statusStore = useStatusStore();

const commentData = computed<CommentConfig>(() => {
  if (!statusStore.commentConfig.id || !statusStore.commentConfig.platform) {
    return {
      id: musicStore.playSong.id,
      name: musicStore.playSong.name,
      creator: Array.isArray(musicStore.playSong.artists)
        ? musicStore.playSong.artists.map((item) => item.name).join(" / ")
        : String(musicStore.playSong.artists),
      platform: musicStore.playSong.platform,
      cover: musicStore.songCover,
      resource_type: "song",
    };
  }
  return statusStore.commentConfig;
});

const tabs = computed(() => [
  {
    name: t("common.hot_comment"),
    value: "hot",
  },
  {
    name: t("common.all_comment"),
    value: "new",
  },
]);

const tab = ref("hot");

const openCommentTarget = () => {
  if (!commentData.value.id || !commentData.value.resource_type) return;
  router.push({
    name: commentData.value.resource_type,
    query: {
      id: commentData.value.id,
      platform: commentData.value.platform,
    },
  });
};
</script>

<style lang="scss" scoped>
.comment {
  position: absolute;
  right: 0;
  flex: 1;
  width: 100%;
  overflow: hidden;
  .song-data {
    height: 90px;
    padding: 0 16px;
    border-radius: 12px;
    background-color: var(--surface-container-hex);
    .cover-img {
      width: 60px;
      height: 60px;
      border-radius: 12px;
      margin-right: 4px;
    }
    .title {
      font-size: 20px;
      font-weight: bold;
    }
    .artist {
      opacity: 0.8;
    }
    .close {
      width: 40px;
      height: 40px;
      margin-left: auto;
      background-color: rgba(var(--n-color-target), 0.08);
      border-radius: 8px;
      transition: background-color 0.3s;
      cursor: pointer;
      //&:hover {
      //  background-color: rgba(var(--main-cover-color), 0.29);
      //}
    }
  }
}
</style>
