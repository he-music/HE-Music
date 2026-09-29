<template>
  <AsyncContent
    class="discover-mvs"
    :failed="failed"
    :loading="loading"
    :has-data="!!videosData.length"
    @retry="retry"
  >
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
    <VideoList
      :data="videosData"
      :loading="loading"
      :load-more="hasMore && !failed"
      @load-more="loadMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import type { MVInfo } from "@/types/main.hemusic";
import { useDataStore } from "@/stores";
import { filterMVs } from "@/api/video";

const props = defineProps<{
  platform: string;
}>();
const dataStore = useDataStore();

const filters = ref<Record<string, string>>({});
const {
  data: videosData,
  loading,
  failed,
  hasMore,
  loadMore,
  retry,
  reset,
} = usePagedRequest<MVInfo>(async (page) => {
  const platform = props.platform;
  const selected = filters.value;
  const query = { ...selected };
  if (page === 1) {
    await dataStore.getMVFilters(platform);
    dataStore.mvFilters[platform]?.forEach((tab) => {
      query[tab.id] ??= tab.options[0]?.value;
    });
    if (platform === props.platform && selected === filters.value) filters.value = query;
  }
  return filterMVs(platform, page, 50, query);
});

const queryChange = (tabId: string, value: string) => {
  filters.value = { ...filters.value, [tabId]: value };
  reset();
};
watch(
  () => props.platform,
  () => {
    filters.value = {};
    reset();
  },
  { immediate: true },
);
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
