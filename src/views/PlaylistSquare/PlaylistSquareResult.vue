<template>
  <AsyncContent
    class="discover-playlists"
    :failed="failed"
    :loading="loading"
    :has-data="!!playlistData.length"
    @retry="retry"
  >
    <n-flex justify="space-between" align="center" class="menu">
      <!-- 分类 -->
      <n-button
        :focusable="false"
        icon-placement="right"
        strong
        secondary
        round
        @click="catChangeShow = true"
      >
        <template #icon>
          <n-icon class="more" depth="3">
            <SvgIcon name="Right" />
          </n-icon>
        </template>
        {{ currentTag?.name }}
      </n-button>
      <!--      &lt;!&ndash; 精品 &ndash;&gt;-->
      <!--      <Transition name="fade" mode="out-in">-->
      <!--        <n-tabs-->
      <!--          v-if="hasHqPlaylist"-->
      <!--          v-model:value="catHqType"-->
      <!--          class="tabs"-->
      <!--          type="segment"-->
      <!--          @update:value="-->
      <!--            (name: string) => changeCatName(catName, name === 'normal' ? 'false' : 'true')-->
      <!--          "-->
      <!--        >-->
      <!--          <n-tab name="normal"> 推荐 </n-tab>-->
      <!--          <n-tab name="hq"> 精品 </n-tab>-->
      <!--        </n-tabs>-->
      <!--      </Transition>-->
    </n-flex>
    <PlaylistList
      :data="playlistData"
      :loading="loading"
      :load-more="hasMore && !failed"
      @load-more="loadMore"
    />
    <!-- 分类选择 -->
    <n-modal
      v-model:show="catChangeShow"
      display-directive="show"
      style="width: 600px"
      preset="card"
    >
      <template #header>
        <n-flex align="center" class="cat-header">
          <n-text>
            {{ t("playlist.category") }}
          </n-text>
          <!--          <n-tag-->
          <!--            :type="catName == '全部歌单' ? 'primary' : 'default'"-->
          <!--            :bordered="false"-->
          <!--            round-->
          <!--            @click="changeCatName('全部歌单')"-->
          <!--          >-->
          <!--            全部歌单-->
          <!--          </n-tag>-->
        </n-flex>
      </template>
      <n-tabs type="segment" animated>
        <n-tab-pane
          v-for="(item, index) in dataStore.playlistCategories[platform] || []"
          :key="index"
          :name="item.name"
          :tab="item.name"
        >
          <n-flex class="cat-list">
            <n-tag
              v-for="(cat, catIndex) in item?.categories || []"
              :key="catIndex"
              :bordered="false"
              :class="{ choose: currentTag?.id === cat.id }"
              size="large"
              round
              @click="changeTag(cat)"
            >
              {{ cat.name }}
              <!--              <template #icon>-->
              <!--                <SvgIcon v-if="cat.hot" :depth="3" name="Fire" />-->
              <!--              </template>-->
            </n-tag>
          </n-flex>
        </n-tab-pane>
      </n-tabs>
    </n-modal>
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import { useDataStore } from "@/stores";
import type { PlaylistInfo, CategoryInfo } from "@/types/main.hemusic";
import PlaylistList from "@/components/List/PlaylistList.vue";
import { watch } from "vue";
import { categoryPlaylists } from "@/api/playlist";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const props = defineProps<{
  platform: string;
  category_id?: string;
}>();

const emit = defineEmits<{
  change: [string];
}>();

const dataStore = useDataStore();
const catChangeShow = ref(false);
const findTag = (platform: string, categoryId?: string) => {
  const tags = (dataStore.playlistCategories[platform] || []).flatMap((group) => group.categories);
  return tags.find((tag) => tag.id === categoryId) || tags[0];
};
const currentTag = computed(() => findTag(props.platform, props.category_id));

const {
  data: playlistData,
  loading,
  failed,
  hasMore,
  loadMore,
  retry,
  reset,
} = usePagedRequest<PlaylistInfo>(async (page, cursor) => {
  const platform = props.platform;
  const categoryId = props.category_id;
  if (page === 1) await dataStore.getPlaylistCategories(platform);
  const tag = findTag(platform, categoryId);
  if (!tag) return { list: [], has_more: false };
  return categoryPlaylists(tag.id, platform, page, 30, cursor);
});

const changeTag = (tag: CategoryInfo) => {
  catChangeShow.value = false;
  emit("change", tag.id);
};
watch(() => [props.platform, props.category_id], reset, { immediate: true });
</script>

<style lang="scss" scoped>
.discover-playlists {
  .menu {
    margin-top: 20px;
    .n-button {
      height: 40px;
    }
    .n-tabs {
      height: 40px;
      width: 140px;
      --n-tab-border-radius: 25px !important;
      :deep(.n-tabs-rail) {
        outline: 1px solid var(--n-tab-color-segment);
      }
    }
  }
}
.cat-list {
  align-content: flex-start;
  min-height: 140px;
  margin-top: 8px;
  .n-tag {
    font-size: 14px;
    .n-icon {
      font-size: 16px;
      margin-left: 4px;
    }
  }
}
</style>
