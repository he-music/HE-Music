<template>
  <div class="mobile-music-detail-header">
    <section ref="introRef" class="mobile-detail-intro">
      <n-image
        class="artwork"
        :class="{ round: roundCover }"
        :src="gatewayProxyUrl(cover || fallbackCover)"
        :preview-src="gatewayProxyUrl(cover || fallbackCover)"
        :render-toolbar="renderToolbar"
        :alt="title"
        object-fit="cover"
        show-toolbar-tooltip
      />
      <div class="metadata">
        <h1 class="title">{{ title }}</h1>
        <n-text v-if="subtitle" class="subtitle" depth="3">{{ subtitle }}</n-text>
        <div class="meta"><slot name="meta" /></div>
      </div>
      <button
        v-if="description"
        class="description"
        type="button"
        @click="openDescModal(description)"
      >
        <span>{{ description }}</span>
        <SvgIcon name="Right" :size="16" />
      </button>
      <div v-if="$slots.tags" class="tags"><slot name="tags" /></div>
    </section>
    <div class="mobile-detail-toolbar" ref="toolbarRef">
      <div v-if="collapsed" class="compact-title" :title="title">{{ title }}</div>
      <div class="actions">
        <n-button
          v-if="showPlay"
          class="play-all"
          type="primary"
          round
          :loading="loading"
          :disabled="disabled || loading"
          @click="emit('play')"
        >
          <template #icon><SvgIcon name="Play" /></template>
          {{ t("common.play_all") }}
        </n-button>
        <div class="secondary-actions"><slot name="actions" /></div>
        <n-button
          v-if="searchable"
          circle
          secondary
          :aria-label="t('search.fuzzy_search')"
          :aria-expanded="searchOpen"
          :type="searchOpen || search ? 'primary' : 'default'"
          @click="toggleSearch"
        >
          <template #icon><SvgIcon name="Search" /></template>
        </n-button>
      </div>
      <div v-if="searchable && (searchOpen || search)" class="search-row">
        <n-input
          ref="searchRef"
          v-model:value="search"
          :input-props="{ autocomplete: 'off', 'aria-label': t('search.fuzzy_search') }"
          :placeholder="t('search.fuzzy_search')"
          clearable
          round
          @keydown.esc="closeSearch"
        >
          <template #prefix><SvgIcon name="Search" /></template>
        </n-input>
        <n-button text :aria-label="t('common.close')" @click="closeSearch">
          {{ t("common.close") }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InputInst } from "naive-ui";
import { useI18n } from "vue-i18n";
import { gatewayProxyUrl } from "@/platform/gateway";
import { renderToolbar } from "@/utils/meta";
import { openDescModal } from "@/utils/modal";
import "@/style/musicDetail.scss";

withDefaults(
  defineProps<{
    title: string;
    cover?: string;
    subtitle?: string;
    description?: string;
    roundCover?: boolean;
    fallbackCover?: string;
    loading?: boolean;
    disabled?: boolean;
    searchable?: boolean;
    showPlay?: boolean;
  }>(),
  { fallbackCover: "/images/album.jpg?asset", showPlay: true },
);
const emit = defineEmits<{ play: [] }>();
const search = defineModel<string>("search", { default: "" });
const { t } = useI18n();
const introRef = ref<HTMLElement | null>(null);
const toolbarRef = ref<HTMLElement | null>(null);
useResizeObserver(toolbarRef, ([entry]) => {
  if (!entry) return;
  const page = entry.target.closest<HTMLElement>(".mobile-detail");
  page?.style.setProperty(
    "--mobile-detail-toolbar-height",
    `${entry.target.getBoundingClientRect().height}px`,
  );
});
const searchRef = ref<InputInst | null>(null);
const searchOpen = ref(false);
const collapsed = ref(false);
let observer: IntersectionObserver | undefined;

const observeIntro = () => {
  observer?.disconnect();
  if (!introRef.value) return;
  let parent = introRef.value.parentElement;
  while (parent && !/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) {
    parent = parent.parentElement;
  }
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;
      collapsed.value =
        !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
    },
    { root: parent instanceof Element ? parent : null },
  );
  observer.observe(introRef.value);
};
const toggleSearch = async () => {
  if (searchOpen.value || search.value) {
    closeSearch();
    return;
  }
  searchOpen.value = true;
  await nextTick();
  searchRef.value?.focus();
};
const closeSearch = () => {
  search.value = "";
  searchOpen.value = false;
};
onMounted(observeIntro);
onActivated(observeIntro);
onDeactivated(() => observer?.disconnect());
onBeforeUnmount(() => observer?.disconnect());
</script>

<style lang="scss" scoped>
.mobile-music-detail-header {
  display: contents;
}
.mobile-detail-intro {
  display: grid;
  grid-template-columns: clamp(104px, 28vw, 128px) minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding: 12px 0 16px;
  .artwork {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
    &.round {
      border-radius: 50%;
    }
    :deep(img) {
      width: 100%;
      height: 100%;
    }
  }
  .metadata {
    min-width: 0;
  }
  .title {
    display: -webkit-box;
    margin: 0 0 8px;
    overflow: hidden;
    font-size: 21px;
    line-height: 1.35;
    font-weight: 700;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .subtitle {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin-top: 6px;
    font-size: 12px;
    :deep(.n-text) {
      min-width: 0;
      overflow-wrap: anywhere;
    }
  }
  .tags {
    grid-column: 1 / -1;
    display: flex;
    gap: 8px;
    min-width: 0;
    overflow-x: auto;
    :deep(.n-button) {
      flex-shrink: 0;
      min-height: 44px;
    }
  }
  .description {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 0;
    border: 0;
    background: transparent;
    color: inherit;
    opacity: 0.65;
    text-align: left;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    span {
      flex: 1;
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .n-icon {
      flex-shrink: 0;
    }
  }
}
.mobile-detail-toolbar {
  position: sticky;
  top: 0;
  z-index: 12;
  flex-shrink: 0;
  padding: 8px 0;
  background: var(--sticky-surface-background, rgb(var(--background)));
  backdrop-filter: var(--sticky-surface-filter, none);
  border-bottom: 1px solid rgba(var(--primary), 0.08);
  .compact-title {
    padding: 4px 0 10px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 16px;
    font-weight: 600;
  }
  .actions,
  .secondary-actions,
  .search-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .play-all {
    margin-right: auto;
    min-width: 0;
  }
  .secondary-actions {
    flex-shrink: 0;
  }
  :deep(.n-button) {
    height: 44px;
  }
  :deep(.n-button--circle) {
    width: 44px;
    flex-shrink: 0;
  }
  .search-row {
    padding-top: 10px;
    .n-input {
      flex: 1;
      min-width: 0;
    }
  }
}
</style>
