<template>
  <div class="toplists">
    <Transition name="fade" mode="out-in">
      <div v-if="!loading" class="official-list">
        <div v-for="(item, idx) in topListData || []" :key="idx">
          <n-divider style="margin-bottom: 0">
            {{ item.name }}
          </n-divider>
          <RankingList :data="item.rankings" />
        </div>
      </div>
      <RankingList v-else :data="[]" loading :loading-num="12" />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { RankingInfo } from "@/types/main.hemusic";
import { listRankings } from "@/api/playlist";
const props = defineProps<{
  platform: string;
}>();

const loading = ref<boolean>(true);

// 排行榜数据
const topListData = ref<
  {
    name: string;
    rankings: RankingInfo[];
  }[]
>();

// 获取排行榜数据
const getTopPlaylistData = async () => {
  loading.value = true;
  const { groups = [] } = await listRankings(props.platform);
  topListData.value = groups;
  loading.value = false;
};

onMounted(getTopPlaylistData);
</script>
