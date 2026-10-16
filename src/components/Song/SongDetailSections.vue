<template>
  <div class="song-detail-sections">
    <section
      v-for="(section, index) in sections"
      :key="`${section.resource_type}-${index}`"
      class="song-detail-section"
    >
      <n-h3 v-if="section.title" prefix="bar" class="section-title">
        <n-text class="title-text">{{ section.title }}</n-text>
        <n-button
          v-if="section.resource_type === 'sheet_music' && canListSheetMusic"
          :aria-label="t('page_section.more', { title: section.title })"
          :title="t('page_section.more', { title: section.title })"
          class="more-button"
          quaternary
          circle
          @click="emit('moreSheetMusic')"
        >
          <template #icon>
            <SvgIcon :size="24" name="Right" />
          </template>
        </n-button>
      </n-h3>
      <SongList
        v-if="section.resource_type === 'song'"
        :data="section.songs ?? []"
        height="auto"
        :show-footer="false"
        disabled-sort
      />
      <AlbumList v-else-if="section.resource_type === 'album'" :data="section.albums ?? []" />
      <VideoList
        v-else-if="section.resource_type === 'mv'"
        :data="section.mvs ?? []"
        cols="2 600:2 800:3 900:4 1200:5 1400:6"
      />
      <PlaylistList
        v-else-if="section.resource_type === 'playlist'"
        :data="section.playlists ?? []"
      />
      <SheetMusicList
        v-else-if="section.resource_type === 'sheet_music'"
        :data="section.sheet_music ?? []"
        :platform="song.platform"
        :song-id="song.id"
        :song-name="song.name"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import type { SongDetailSection, SongInfo } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import SongList from "@/components/List/SongList.vue";
import VideoList from "@/components/List/VideoList.vue";
import SheetMusicList from "@/components/List/SheetMusicList.vue";
import { useI18n } from "vue-i18n";

defineProps<{
  sections: SongDetailSection[];
  song: Pick<SongInfo, "id" | "platform" | "name">;
  canListSheetMusic: boolean;
}>();
const emit = defineEmits<{ moreSheetMusic: [] }>();
const { t } = useI18n();
</script>

<style lang="scss" scoped>
.song-detail-sections,
.song-detail-section {
  width: 100%;
  min-width: 0;
}

.song-detail-section + .song-detail-section {
  margin-top: 12px;
}

.section-title {
  display: flex;
  align-items: center;
  width: max-content;
  max-width: 100%;
  margin: 14px 0 0;

  .title-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more-button {
    flex: 0 0 32px;
    width: 32px;
    height: 32px;
    margin-left: 2px;
    opacity: 0.62;
    transition: opacity 0.2s var(--n-bezier);

    &:hover,
    &:focus-visible {
      opacity: 1;
    }
  }
}
</style>
