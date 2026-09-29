<template>
  <AsyncContent
    class="discover-artists"
    :failed="failed"
    :loading="loading"
    :has-data="!!artistsData.length"
    @retry="retry"
  >
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
      :load-more="hasMore && !failed"
      hidden-item
      @load-more="loadMore"
    />
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import { filterArtists } from "@/api/artist";
import type { ArtistInfo } from "@/types/main.hemusic";
import { useDataStore } from "@/stores";

const props = defineProps<{
  platform: string;
}>();
const dataStore = useDataStore();

const filters = ref<Record<string, string>>({});
const {
  data: artistsData,
  loading,
  failed,
  hasMore,
  loadMore,
  retry,
  reset,
} = usePagedRequest<ArtistInfo>(async (page) => {
  const platform = props.platform;
  const selected = filters.value;
  const query = { ...selected };
  if (page === 1) {
    await dataStore.getArtistFilters(platform);
    dataStore.artistFilters[platform]?.forEach((tab) => {
      query[tab.id] ??= tab.options[0]?.value;
    });
    if (platform === props.platform && selected === filters.value) filters.value = query;
  }
  return filterArtists(platform, page, 50, query);
});

const artistQueryChange = (tabId: string, value: string) => {
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
.discover-artists {
  .menu {
    margin-top: 5px;
    .category {
      margin-top: 5px;
    }
  }
}
</style>
