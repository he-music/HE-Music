<template>
  <AsyncContent class="radio" :failed="failed" :loading="loading" @retry="retry">
    <PageTabs v-if="!loading" v-model:value="tabValue" category class="tabs page-secondary-tabs">
      <n-tab-pane
        v-for="tab in radioListData"
        :key="`radio-group-${props.platform}-${tab.name}`"
        :name="tab.name"
        :tab="tab.name"
        display-directive="show:lazy"
      >
        <PagePlatformScroll :reset-key="tabValue">
          <RadioList :data="tab.radios" />
        </PagePlatformScroll>
      </n-tab-pane>
    </PageTabs>
    <div v-else class="skeleton-container" aria-hidden="true" inert>
      <PageTabs value="0" category class="tabs page-secondary-tabs">
        <n-tab-pane
          v-for="(width, index) in categorySkeletonWidths"
          :key="index"
          :name="String(index)"
          display-directive="show:lazy"
        >
          <template #tab>
            <span class="category-skeleton-label">
              <n-skeleton :width="width" height="16px" :sharp="false" />
            </span>
          </template>
          <PagePlatformScroll loading>
            <RadioList :data="[]" loading />
          </PagePlatformScroll>
        </n-tab-pane>
      </PageTabs>
    </div>
  </AsyncContent>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import PagePlatformScroll from "@/components/Page/PagePlatformScroll.vue";
import PageTabs from "@/components/Page/PageTabs.vue";
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
.radio,
.skeleton-container {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.radio {
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
