<template>
  <div class="quick-entry-grid">
    <button
      v-for="entry in entries"
      :key="`${entry.target_type}-${entry.target_id}`"
      type="button"
      class="quick-entry"
      :aria-busy="loadingEntryId === entry.target_id"
      @click="openEntry(entry)"
    >
      <SImage
        :src="entry.cover"
        :alt="entry.title"
        default-src="/images/album.jpg?asset"
        class="entry-cover"
      />
      <span class="entry-scrim" aria-hidden="true" />
      <span class="entry-copy">
        <n-text class="entry-title">{{ entry.title }}</n-text>
        <n-text v-if="entry.subtitle" class="entry-subtitle">
          {{ entry.subtitle }}
        </n-text>
      </span>
      <span
        v-if="loadingEntryId === entry.target_id || entry.target_type === PageEntryTargetType.Radio"
        class="entry-action"
        aria-hidden="true"
      >
        <n-spin v-if="loadingEntryId === entry.target_id" :size="18" />
        <SvgIcon v-else :size="18" :name="isPlayingRadio(entry) ? 'Pause' : 'Play'" />
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import SImage from "@/components/UI/s-image.vue";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import { useMusicStore, useStatusStore } from "@/stores";
import { PageEntryTargetType, type PageEntry } from "@/types/page";
import { resolvePageEntryAction } from "@/utils/pageEntry";
import { usePlayer } from "@/utils/player";

const props = defineProps<{
  entries: PageEntry[];
  platform: string;
}>();

const router = useRouter();
const player = usePlayer();
const musicStore = useMusicStore();
const statusStore = useStatusStore();
const loadingEntryId = ref("");

const isCurrentRadio = (entry: PageEntry) =>
  entry.target_type === PageEntryTargetType.Radio &&
  statusStore.radioMode &&
  musicStore.radio.id === entry.target_id &&
  musicStore.radio.platform === props.platform;

const isPlayingRadio = (entry: PageEntry) => isCurrentRadio(entry) && statusStore.playStatus;

const openEntry = async (entry: PageEntry) => {
  const action = resolvePageEntryAction(entry, props.platform);
  if (!action) return;

  if (action.type === "route") {
    await router.push({ name: action.routeName, query: action.query });
    return;
  }

  if (loadingEntryId.value) return;
  if (isCurrentRadio(entry)) {
    player.playOrPause();
    return;
  }

  loadingEntryId.value = entry.target_id;
  try {
    musicStore.radio.name = action.title;
    musicStore.radio.id = action.id;
    musicStore.radio.platform = action.platform;
    await player.nextRadio(true);
  } finally {
    loadingEntryId.value = "";
  }
};
</script>

<style lang="scss" scoped>
.quick-entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 156px);
  gap: 16px;
  width: 100%;
  justify-content: start;
  padding: 12px 4px 22px;
}

.quick-entry {
  position: relative;
  display: flex;
  min-width: 0;
  width: 156px;
  aspect-ratio: 1 / 1;
  align-items: center;
  padding: 0;
  overflow: hidden;
  color: inherit;
  text-align: left;
  background: rgba(var(--primary), 0.08);
  border: 1px solid rgba(var(--primary), 0.16);
  border-radius: 8px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  transition:
    border-color 0.2s var(--n-bezier),
    box-shadow 0.2s var(--n-bezier),
    transform 0.2s var(--n-bezier);

  &:hover {
    border-color: rgba(var(--primary), 0.38);
    box-shadow: 0 7px 16px rgba(0, 0, 0, 0.18);
    transform: translateY(-1px);

    .entry-cover :deep(img) {
      transform: scale(1.04);
    }
  }

  &:active {
    transform: scale(0.99);
  }

  &:focus-visible {
    outline: 2px solid rgb(var(--primary));
    outline-offset: 2px;
  }
}

.entry-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;

  :deep(img) {
    object-fit: cover;
    transition: transform 0.25s var(--n-bezier);
  }
}

.entry-scrim {
  position: absolute;
  inset: 38% 0 0;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.72));
  pointer-events: none;
}

.entry-copy {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  padding: 28px 12px 11px;
  z-index: 1;
}

.entry-title,
.entry-subtitle {
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

.entry-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.25;
  display: -webkit-box;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
}

.entry-subtitle {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  opacity: 0.82;
}

.entry-action {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.36);
  border-radius: 50%;
  backdrop-filter: blur(5px);
  z-index: 2;

  :deep(.n-spin-body) {
    --n-color: #fff;
  }
}

@media (max-width: 600px) {
  .quick-entry-grid {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scrollbar-width: none;
    overscroll-behavior-x: contain;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .quick-entry {
    flex: 0 0 112px;
    width: 112px;
    scroll-snap-align: start;
  }

  .entry-copy {
    padding: 22px 9px 9px;
  }

  .entry-title {
    font-size: 14px;
  }

  .entry-action {
    top: 6px;
    right: 6px;
    width: 27px;
    height: 27px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .quick-entry {
    transition: none;
  }
}
</style>
