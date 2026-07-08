<template>
  <div class="discover-mvs">
    <div v-if="dataStore.mvFilters[platform]" class="menu">
      <n-flex v-for="tab in dataStore.mvFilters[platform]" :key="tab.id" class="category">
        <n-tag
          v-for="opt in tab.options"
          :key="opt.value"
          :bordered="opt.value == filters[tab.id]"
          :type="opt.value == filters[tab.id] ? 'primary' : 'default'"
          round
          @click="queryChange(tab.id, opt.value)"
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
    <VideoList :data="videosData" :loading="loading" :load-more="hasMore" @load-more="loadMore" />
  </div>
</template>

<script setup lang="ts">
import type { MVInfo } from "@/types/main.hemusic";
import { useDataStore } from "@/stores";
import { filterMVs } from "@/api/video";

const props = defineProps<{
  platform: string;
}>();
const dataStore = useDataStore();

const filters = ref({});

// 歌手数据
const hasMore = ref<boolean>(true);
const loading = ref<boolean>(true);
const pageIndex = ref<number>(1);
const videosData = ref<MVInfo[]>([]);

// 获取歌手数据
const getListData = async () => {
  // 获取数据
  loading.value = true;
  const result = await filterMVs(props.platform, pageIndex.value, 50, filters.value);
  // 是否还有
  hasMore.value = result?.has_more;
  videosData.value = videosData.value?.concat(result.list);
  loading.value = false;
};

// 参数变化
const queryChange = (tabId: string, value: string) => {
  filters.value[tabId] = value;
  pageIndex.value = 1;
  loading.value = true;
  videosData.value = [];
  getListData();
};

// 加载更多
const loadMore = () => {
  pageIndex.value++;
  getListData();
};

onMounted(async () => {
  await dataStore.getMVFilters(props.platform);
  dataStore.mvFilters[props.platform]?.forEach((tab) => {
    filters.value[tab.id] = tab.options[0]?.value;
  });
  await getListData();
});
</script>

<style lang="scss" scoped>
.discover-mvs {
  .menu {
    margin-top: 5px;
    .category {
      margin-top: 5px;
    }
  }
}
</style>
