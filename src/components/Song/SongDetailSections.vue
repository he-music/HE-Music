<template>
  <div class="song-detail-sections">
    <section
      v-for="(section, index) in sections"
      :key="`${section.resource_type}-${index}`"
      class="song-detail-section"
    >
      <n-h3 v-if="section.title" prefix="bar" class="section-title">
        <n-text class="title-text">{{ section.title }}</n-text>
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
    </section>
  </div>
</template>

<script setup lang="ts">
import type { SongDetailSection } from "@/types/main.hemusic";
import AlbumList from "@/components/List/AlbumList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import SongList from "@/components/List/SongList.vue";
import VideoList from "@/components/List/VideoList.vue";

defineProps<{ sections: SongDetailSection[] }>();
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
  width: max-content;
  max-width: 100%;
  margin: 14px 0 0;

  .title-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
