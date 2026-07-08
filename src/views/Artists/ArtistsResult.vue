<template>
  <div class="discover-artists">
    <div v-if="dataStore.artistFilters[platform]" class="menu">
      <n-flex v-for="tab in dataStore.artistFilters[platform]" :key="tab.id" class="category">
        <n-tag
          v-for="opt in tab.options"
          :key="opt.value"
          :type="opt.value == filters[tab.id] ? 'primary' : 'default'"
          :bordered="opt.value == filters[tab.id]"
          round
          @click="artistQueryChange(tab.id, opt.value)"
        >
          {{ opt.label }}
        </n-tag>
      </n-flex>
    </div>
    <div v-else class="menu">
      <n-flex wrap class="category">
        <n-skeleton v-for="i in 26" :key="'tag1-' + i" text :width="30" :height="30" round />
      </n-flex>
      <n-flex wrap class="category">
        <n-skeleton v-for="i in 10" :key="'tag2-' + i" text :width="50" :height="30" round />
      </n-flex>
    </div>
    <ArtistList
      :data="artistsData"
      :loading="loading"
      :load-more="hasMore"
      hidden-item
      @load-more="loadMore"
    />
  </div>
</template>

<script setup lang="ts">
import { filterArtists } from "@/api/artist";
import type { ArtistInfo } from "@/types/main.hemusic";
import { useDataStore } from "@/stores";

const props = defineProps<{
  platform: string;
}>();
const dataStore = useDataStore();

const filters = ref({});

// 歌手数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const artistsPageIndex = ref<number>(1);
const artistsData = ref<ArtistInfo[]>([]);

// 获取歌手数据
const getArtistListData = async () => {
  // 获取数据
  loading.value = true;
  const result = await filterArtists(props.platform, artistsPageIndex.value, 50, filters.value);
  // 是否还有
  hasMore.value = result?.has_more;
  artistsData.value = artistsData.value?.concat(result.list);
  loading.value = false;
};

// 参数变化
const artistQueryChange = (tabId: string, value: string) => {
  filters.value[tabId] = value;
  artistsPageIndex.value = 1;
  loading.value = true;
  artistsData.value = [];
  getArtistListData();
};

// 加载更多
const loadMore = () => {
  artistsPageIndex.value++;
  getArtistListData();
};

// 参数变化
// onBeforeRouteUpdate((to) => {
//   // 获取歌单
//   loading.value = true;
//   artistsData.value = [];
//   getArtistListData();
// });

onMounted(async () => {
  await dataStore.getArtistFilters(props.platform);
  dataStore.artistFilters[props.platform]?.forEach((tab) => {
    filters.value[tab.id] = tab.options[0]?.value;
  });

  await getArtistListData();
});
</script>

<style lang="scss" scoped>
.discover-artists {
  .menu {
    margin-top: 5px;
    .category {
      margin-top: 5px;
    }
  }
}
</style>
