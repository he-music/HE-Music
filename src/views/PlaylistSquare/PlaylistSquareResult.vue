<template>
  <div class="discover-playlists">
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
      v-if="playlistCount > 0"
      :data="playlistData"
      :loading="loading"
      :load-more="hasMore"
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
  </div>
</template>

<script setup lang="ts">
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

const group_name = ref<string>("");

const dataStore = useDataStore();

const catChangeShow = ref<boolean>(false);

const currentTag = ref<CategoryInfo>();

// 歌单数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const playlistPageIndex = ref<number>(1);
const playlistCount = ref<number>(1);
const playlistData = ref<PlaylistInfo[]>([]);
const last_id = ref<string>("");

// 获取歌单数据
const getAllCatlistPlaylist = async () => {
  if (!currentTag.value) {
    return;
  }
  // 获取数据
  loading.value = true;
  const result = await categoryPlaylists(
    currentTag.value.id,
    props.platform,
    playlistPageIndex.value,
    30,
    last_id.value,
  );
  // 是否还有
  hasMore.value = result.has_more;
  last_id.value = result.last_id;
  // 处理数据
  playlistData.value = playlistData.value?.concat(result.list);
  playlistCount.value = playlistData.value.length;
  loading.value = false;
};

// 加载更多
const loadMore = () => {
  playlistPageIndex.value++;
  getAllCatlistPlaylist();
};

// 分类切换
const changeTag = (tag: CategoryInfo) => {
  catChangeShow.value = false;
  emit("change", tag.id);
};

watch(
  () => props.category_id,
  async (to) => {
    [group_name.value, currentTag.value] = findTag(to || "");
    resetData();
    await getAllCatlistPlaylist();
  },
);

const resetData = () => {
  playlistData.value = [];
  playlistPageIndex.value = 1;
  last_id.value = "";
};

// watch(()=> props.tag_id,(to)=>{
//   console.log('tag_id',to)
//   let found:TagInfo = null
//   if (to){
//     for (let catDatumKey in dataStore.catData[props.platform]) {
//       found = dataStore.catData[props.platform][catDatumKey].tag_list.find((item)=>item.id === to)
//       if (found){
//         break
//       }
//     }
//   }
//   if (found){
//     currentTag.value = found;
//   }else{
//     currentTag.value = dataStore.catData[props.platform][0]?.tag_list[0];
//   }
// })

const findTag = (tag_id: string): [string, CategoryInfo] => {
  if (tag_id) {
    for (let catDatumKey in dataStore.playlistCategories[props.platform]) {
      const found = dataStore.playlistCategories[props.platform][catDatumKey].categories.find(
        (item) => item.id === tag_id,
      );
      if (found) {
        return [dataStore.playlistCategories[props.platform][catDatumKey].name, found];
      }
    }
  }

  return [
    dataStore.playlistCategories[props.platform][0]?.name,
    dataStore.playlistCategories[props.platform][0]?.categories[0],
  ];
};

onMounted(async () => {
  await dataStore.getPlaylistCategories(props.platform);

  [group_name.value, currentTag.value] = findTag(props.category_id || "");
  // 获取歌单
  await getAllCatlistPlaylist();
});
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
