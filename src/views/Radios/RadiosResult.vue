<template>
  <div class="radio">
    <n-tabs v-if="!loading" v-model:value="tabValue" class="tabs" type="card" animated>
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
    <div v-else class="skeleton-container">
      <!-- 分类标签骨架屏 -->
      <n-flex wrap class="category-skeleton">
        <n-skeleton v-for="i in 10" :key="'tag-' + i" text :width="60" height="30px" />
      </n-flex>

      <!-- 内容列表骨架屏 -->
      <div class="list-skeleton">
        <RadioList :data="[]" loading />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RadioInfo } from "@/types/main.hemusic";

import { onMounted, watch } from "vue";
import { listRadios } from "@/api/radio";
import RadioList from "@/components/List/RadioList.vue";
const props = defineProps<{
  platform: string;
}>();

const route = useRoute();
const loading = ref<boolean>(true);

const tabValue = ref<string>("");

// 排行榜数据
const radioListData = ref<
  {
    name: string;
    radios: RadioInfo[];
  }[]
>();

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

const getRadioList = async () => {
  loading.value = true;
  const result = await listRadios(props.platform);
  radioListData.value = result.groups || [];
  loading.value = false;
  selectRadioGroup();
};

onMounted(() => {
  getRadioList();
});

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
    //padding: 20px;

    .category-skeleton {
      margin-bottom: 24px;
      padding: 0 4px;
    }

    .list-skeleton {
      width: 100%;

      .skeleton-item {
        width: 100%;
        padding: 12px;
      }
    }
  }

  .tabs {
    width: 100%;
  }
}
</style>
