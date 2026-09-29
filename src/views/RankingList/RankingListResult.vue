<template>
  <AsyncContent class="toplists" :failed="failed" :loading="loading" @retry="retry">
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
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { useAsyncRequest } from "@/composables/useAsyncRequest";
import type { RankingInfo } from "@/types/main.hemusic";
import { listRankings } from "@/api/playlist";
const props = defineProps<{
  platform: string;
}>();

const {
  data: topListData,
  loading,
  failed,
  retry,
  reset,
} = useAsyncRequest<{ name: string; rankings: RankingInfo[] }[]>(async () => {
  const { groups = [] } = await listRankings(props.platform);
  return groups;
});
watch(() => props.platform, reset, { immediate: true });
</script>
