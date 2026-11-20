<template>
  <div class="discover-playlists">
    <div v-if="quickCategories.length" class="category-bar page-filters">
      <div
        ref="categoryStrip"
        class="category-strip"
        role="group"
        :aria-label="t('playlist.category')"
      >
        <n-button
          v-for="category in quickCategories"
          :key="category.id"
          size="small"
          round
          secondary
          :type="currentTag?.id === category.id ? 'primary' : 'default'"
          :aria-pressed="currentTag?.id === category.id"
          @click="changeTag(category)"
        >
          {{ category.name }}
        </n-button>
      </div>
      <n-button
        class="all-categories"
        size="small"
        icon-placement="right"
        secondary
        round
        :aria-label="t('playlist.all_categories')"
        aria-haspopup="dialog"
        :aria-expanded="catChangeShow"
        @click="showCategories"
      >
        <template #icon>
          <SvgIcon name="DropDown" />
        </template>
        {{ t("playlist.all_categories_short") }}
      </n-button>
    </div>
    <AsyncContent
      :failed="failed"
      :loading="loading"
      :has-data="!!playlistData.length"
      @retry="retry"
    >
      <PlaylistList
        :data="playlistData"
        :loading="loading"
        :load-more="hasMore && !failed"
        @load-more="loadMore"
      />
    </AsyncContent>
    <n-modal
      v-model:show="catChangeShow"
      display-directive="show"
      class="category-modal"
      preset="card"
      :title="t('playlist.all_categories')"
    >
      <n-tabs v-model:value="categoryGroupName" type="segment" animated>
        <n-tab-pane
          v-for="group in categoryGroups"
          :key="group.name"
          :name="group.name"
          :tab="group.name"
        >
          <n-flex class="cat-list">
            <n-button
              v-for="category in group.categories"
              :key="category.id"
              :type="currentTag?.id === category.id ? 'primary' : 'default'"
              :aria-pressed="currentTag?.id === category.id"
              size="small"
              secondary
              round
              @click="changeTag(category)"
            >
              {{ category.name }}
            </n-button>
          </n-flex>
        </n-tab-pane>
      </n-tabs>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import AsyncContent from "@/components/Page/AsyncContent.vue";
import { usePagedRequest } from "@/composables/usePagedRequest";
import { useDataStore } from "@/stores";
import type { PlaylistInfo, CategoryInfo } from "@/types/main.hemusic";
import PlaylistList from "@/components/List/PlaylistList.vue";
import { watch } from "vue";
import { categoryPlaylists } from "@/api/playlist";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const props = defineProps<{
  platform: string;
  category_id?: string;
}>();

const emit = defineEmits<{
  change: [string];
}>();

const dataStore = useDataStore();
const catChangeShow = ref(false);
const categoryGroupName = ref<string>();
const categoryStrip = ref<HTMLElement | null>(null);
const categoryGroups = computed(() => dataStore.playlistCategories[props.platform] ?? []);
const categories = computed(() => categoryGroups.value.flatMap((group) => group.categories));
const findTag = (tags: CategoryInfo[], categoryId?: string) =>
  tags.find((tag) => tag.id === categoryId) ?? tags[0];
const currentTag = computed(() => findTag(categories.value, props.category_id));
const quickCategories = computed(() => {
  const limit = 10;
  const tags = categories.value;
  const selected = currentTag.value;
  const firstTags = tags.slice(0, limit);
  if (!selected || firstTags.includes(selected)) return firstTags;
  return [...firstTags.slice(0, -1), selected];
});

const {
  data: playlistData,
  loading,
  failed,
  hasMore,
  loadMore,
  retry,
  reset,
} = usePagedRequest<PlaylistInfo>(async (page, cursor) => {
  const platform = props.platform;
  const categoryId = props.category_id;
  if (page === 1) await dataStore.getPlaylistCategories(platform);
  if (platform !== props.platform || categoryId !== props.category_id) {
    return { list: [], has_more: false };
  }
  const tag = findTag(categories.value, categoryId);
  if (!tag) return { list: [], has_more: false };
  return categoryPlaylists(tag.id, platform, page, 30, cursor);
});

const showCategories = () => {
  const selected = currentTag.value;
  const selectedGroup = selected
    ? categoryGroups.value.find((group) => group.categories.includes(selected))
    : undefined;
  categoryGroupName.value = selectedGroup?.name ?? categoryGroups.value[0]?.name;
  catChangeShow.value = true;
};

const changeTag = (tag: CategoryInfo) => {
  catChangeShow.value = false;
  if (tag.id !== currentTag.value?.id) emit("change", tag.id);
};

watch(
  [categoryStrip, currentTag],
  ([strip]) => {
    const selected = strip?.querySelector('[aria-pressed="true"]');
    if (!strip || !selected) return;

    const viewport = strip.getBoundingClientRect();
    const chip = selected.getBoundingClientRect();
    if (chip.left < viewport.left) strip.scrollLeft += chip.left - viewport.left;
    else if (chip.right > viewport.right) strip.scrollLeft += chip.right - viewport.right;
  },
  { flush: "post" },
);

watch(() => [props.platform, props.category_id], reset, { immediate: true });
</script>

<style lang="scss" scoped>
.category-bar {
  --category-strip-inset: 2px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding-block: 6px;
}

.category-strip {
  display: flex;
  flex: 1;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
  padding: var(--category-strip-inset);
  scrollbar-width: thin;

  > .n-button {
    flex: none;
  }
}

.all-categories {
  flex: none;
  margin-block-start: var(--category-strip-inset);
}

.category-modal {
  width: min(600px, calc(100% - 32px));
}

.cat-list {
  max-height: 55vh;
  overflow-y: auto;
  margin-top: 8px;
  padding: 2px;
}
</style>
