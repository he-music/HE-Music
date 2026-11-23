<template>
  <div class="release-page platform-page">
    <PagePlatformTabs v-if="platform" :value="platform" @update:value="platformChange">
      <n-tab-pane v-for="item in platforms" :key="item.id" :name="item.id" :tab="item.shortname">
        <AsyncContent class="release-content" :failed="failed" :loading="loading" @retry="retry">
          <template v-if="loading">
            <PageTabSkeleton />
            <div class="release-skeleton" aria-hidden="true"><slot name="skeleton" /></div>
          </template>
          <PageTabs
            v-else-if="tabs?.length"
            :value="tabId"
            class="page-secondary-tabs"
            category
            @update:value="tagChange"
          >
            <n-tab-pane
              v-for="tab in tabs"
              :key="tab.id"
              :name="tab.id"
              :tab="tab.name"
              display-directive="show:lazy"
            >
              <slot :platform="item.id" :tab-id="tab.id" />
            </n-tab-pane>
          </PageTabs>
          <n-empty v-else :description="t('page_section.empty')" size="large" />
        </AsyncContent>
      </n-tab-pane>
    </PagePlatformTabs>
    <template v-else-if="platformLoading">
      <PageTabSkeleton />
      <PageTabSkeleton />
      <div class="release-skeleton" aria-hidden="true"><slot name="skeleton" /></div>
    </template>
    <PlatformAccessEmpty v-else />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { usePlatformTabs, type ReleaseRouteName } from "@/composables/usePlatformTabs";
import type { TabInfo } from "@/types/main.hemusic";
import AsyncContent from "./AsyncContent.vue";
import PagePlatformTabs from "./PagePlatformTabs.vue";
import PageTabs from "./PageTabs.vue";
import PageTabSkeleton from "./PageTabSkeleton.vue";
import PlatformAccessEmpty from "./PlatformAccessEmpty.vue";

const props = defineProps<{
  routeName: ReleaseRouteName;
  requiredFlags: bigint;
  fetchTabs: (platform: string) => Promise<{ list: TabInfo[] }>;
}>();
defineSlots<{
  default(props: { platform: string; tabId: string }): unknown;
  skeleton(): unknown;
}>();
const { t } = useI18n();
const {
  platforms,
  platform,
  platformLoading,
  platformChange,
  tabId,
  tabs,
  loading,
  failed,
  retry,
  tagChange,
} = usePlatformTabs(props.routeName, props.requiredFlags, props.fetchTabs);
</script>

<style scoped>
.release-page :deep(.page-platform-tabs > .page-tabs > .n-tab-pane) {
  padding-top: 0;
}

.release-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.release-skeleton {
  flex: 1;
  min-height: 0;
  margin-top: 8px;
  overflow: hidden;
}

.release-page > :deep(.n-empty),
.release-content > :deep(.n-empty) {
  margin-top: 72px;
}
</style>
