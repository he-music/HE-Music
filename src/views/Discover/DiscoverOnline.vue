<template>
  <div class="discover-online">
    <PageSectionList v-if="sections.length" :sections="sections" :platform="platform" />
    <PageSectionSkeleton v-else-if="loading" />
    <n-result
      v-else-if="failed"
      status="error"
      :title="t('page_section.load_failed')"
      :description="t('page_section.load_failed_description')"
    >
      <template #footer>
        <n-button secondary type="primary" @click="loadSections">
          {{ t("page_section.retry") }}
        </n-button>
      </template>
    </n-result>
    <n-empty v-else :description="t('page_section.empty')" size="large" />
  </div>
</template>

<script setup lang="ts">
import { discoverPage } from "@/api/page";
import PageSectionList from "@/components/Page/PageSectionList.vue";
import PageSectionSkeleton from "@/components/Page/PageSectionSkeleton.vue";
import type { NormalizedPageSection } from "@/types/page";
import { normalizePageSections } from "@/utils/pageSection";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  platform: string;
}>();

const { t } = useI18n();
const sections = ref<NormalizedPageSection[]>([]);
const loading = ref(true);
const failed = ref(false);

const loadSections = async () => {
  loading.value = true;
  failed.value = false;
  try {
    const response = await discoverPage(props.platform);
    sections.value = normalizePageSections(response.sections || []);
  } catch (error) {
    failed.value = true;
    console.error("Error getting discover page:", error);
  } finally {
    loading.value = false;
  }
};

onMounted(loadSections);
</script>

<style lang="scss" scoped>
.discover-online {
  width: 100%;
  min-width: 0;
  padding-bottom: 24px;

  .n-result,
  .n-empty {
    margin-top: 72px;
  }
}
</style>
