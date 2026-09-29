<template>
  <AsyncContent
    class="search-type"
    :failed="failed"
    :loading="loading"
    :has-data="!!data.length"
    @retry="retry"
  >
    <template v-if="data.length || loading">
      <AlbumList
        v-if="type === 'album' || type === 'audiobook'"
        :data="data as AlbumInfo[]"
        :loading="loading"
        :load-more="hasMore && !failed"
        @load-more="loadMore"
      />
      <ArtistList
        v-else-if="type === 'artist'"
        :data="data as ArtistInfo[]"
        :loading="loading"
        :load-more="hasMore && !failed"
        @load-more="loadMore"
      />
      <PlaylistList
        v-else-if="type === 'playlist'"
        :data="data as PlaylistInfo[]"
        :loading="loading"
        :load-more="hasMore && !failed"
        @load-more="loadMore"
      />
      <VideoList
        v-else
        :data="data as MVInfo[]"
        :loading="loading"
        :load-more="hasMore && !failed"
        cols="2 600:2 800:3 900:4 1200:5 1400:6"
        type="video"
        @load-more="loadMore"
      />
    </template>
    <n-empty
      v-else
      :description="t(emptyMessage, { keyword })"
      style="margin-top: 60px"
      size="large"
    >
      <template #icon><SvgIcon name="SearchOff" /></template>
    </n-empty>
  </AsyncContent>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { searchResultHemusic } from "@/api/search";
import { usePagedRequest } from "@/composables/usePagedRequest";
import AsyncContent from "@/components/Page/AsyncContent.vue";
import AlbumList from "@/components/List/AlbumList.vue";
import ArtistList from "@/components/List/ArtistList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import VideoList from "@/components/List/VideoList.vue";
import type { AlbumInfo, ArtistInfo, PlaylistInfo, MVInfo } from "@/types/main.hemusic";

const props = defineProps<{
  keyword: string;
  platform: string;
  type: "album" | "audiobook" | "artist" | "playlist" | "mv";
}>();
const { t } = useI18n();
const emptyMessage = computed(
  () => `search.no_${props.type === "mv" ? "video" : props.type}_result`,
);
const { data, loading, failed, hasMore, loadMore, retry, reset } = usePagedRequest<
  AlbumInfo | ArtistInfo | PlaylistInfo | MVInfo
>((page) => searchResultHemusic(props.keyword, 30, page, props.platform, props.type));
watch(() => [props.keyword, props.platform, props.type], reset, { immediate: true });
</script>
