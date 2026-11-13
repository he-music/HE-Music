<template>
  <AsyncContent class="radio" :failed="failed" :loading="loading" @retry="retry">
    <n-tabs v-if="!loading" v-model:value="tabValue" class="tabs page-secondary-tabs" type="card">
      <n-tab-pane
        v-for="tab in radioListData"
        :key="`radio-group-${props.platform}-${tab.name}`"
        :name="tab.name"
        :tab="tab.name"
        display-directive="show:lazy"
      >
        <RadioList :data="tab.radios" />
      </n-tab-pane>
    </n-tabs>
    <div v-else class="skeleton-container" aria-hidden="true" inert>
      <n-tabs :value="0" class="tabs page-secondary-tabs" type="card">
        <n-tab-pane
          v-for="(width, index) in categorySkeletonWidths"
          :key="index"
          :name="index"
          display-directive="show:lazy"
        >
          <template #tab>
            <span class="category-skeleton-label">
              <n-skeleton :width="width" height="16px" :sharp="false" />
            </span>
          </template>
          <RadioList :data="[]" loading />
        </n-tab-pane>
      </n-tabs>
    </div>
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { useAsyncRequest } from "@/composables/useAsyncRequest";
import type { RadioInfo } from "@/types/main.hemusic";

import { watch } from "vue";
import { listRadios } from "@/api/radio";
import RadioList from "@/components/List/RadioList.vue";
const props = defineProps<{
  platform: string;
}>();

const route = useRoute();
const {
  data: radioListData,
  loading,
  failed,
  retry,
  reset,
} = useAsyncRequest<{ name: string; radios: RadioInfo[] }[]>(async () => {
  const result = await listRadios(props.platform);
  return result.groups || [];
});

const categorySkeletonWidths = [32, 56, 40, 64, 32, 48];
const tabValue = ref<string>("");

const selectRadioGroup = () => {
  const targetRadioId = route.query.radio_id as string;
  const radioGroups = radioListData.value || [];
  if (!targetRadioId || radioGroups.length === 0) {
    tabValue.value = radioGroups[0]?.name || "";
    return;
  }

  const targetGroup = radioGroups.find((group) =>
    group.radios.some((radio) => radio.id === targetRadioId && radio.platform === props.platform),
  );
  tabValue.value = targetGroup?.name || radioGroups[0]?.name || "";
};

watch(() => props.platform, reset, { immediate: true });
watch(radioListData, selectRadioGroup);

watch(
  () => route.query.radio_id,
  () => selectRadioGroup(),
);
</script>

<style lang="scss" scoped>
.radio {
  display: flex;
  flex-direction: column;
  .skeleton-container {
    width: 100%;
    min-width: 0;
  }

  .category-skeleton-label {
    display: inline-flex;
    align-items: center;
    height: 1.5em;
  }

  .tabs {
    width: 100%;
  }
}
</style>
