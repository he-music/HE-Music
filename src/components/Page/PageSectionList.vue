<template>
  <div class="page-section-list">
    <section
      v-for="(item, index) in displaySections"
      :key="`${item.section.section_type}-${item.section.resource_type}-${item.section.title}-${index}`"
      class="page-section"
    >
      <n-h3 v-if="item.title" prefix="bar" class="section-title">
        <n-text class="title-text">{{ item.title }}</n-text>
        <n-button
          v-if="item.routeName"
          :aria-label="t('page_section.more', { title: item.title })"
          :title="t('page_section.more', { title: item.title })"
          class="more-button"
          quaternary
          circle
          @click="openMore(item.routeName)"
        >
          <template #icon>
            <SvgIcon :size="24" name="Right" />
          </template>
        </n-button>
      </n-h3>

      <SongList
        v-if="item.section.resource_type === 'song'"
        :data="item.section.songs || []"
        height="auto"
        :show-footer="false"
      />
      <AlbumList
        v-else-if="item.section.resource_type === 'album'"
        :data="item.section.albums || []"
      />
      <VideoList
        v-else-if="item.section.resource_type === 'mv'"
        :data="item.section.mvs || []"
        cols="2 600:2 800:3 900:4 1200:5 1400:6"
      />
      <PlaylistList
        v-else-if="item.section.resource_type === 'playlist'"
        :data="item.section.playlists || []"
      />
      <RankingList
        v-else-if="item.section.resource_type === 'ranking'"
        :data="item.section.rankings || []"
      />
      <RadioList
        v-else-if="item.section.resource_type === 'radio'"
        :data="item.section.radios || []"
      />
      <ArtistList
        v-else-if="item.section.resource_type === 'artist'"
        :data="item.section.artists || []"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import SvgIcon from "@/components/Global/SvgIcon.vue";
import AlbumList from "@/components/List/AlbumList.vue";
import ArtistList from "@/components/List/ArtistList.vue";
import PlaylistList from "@/components/List/PlaylistList.vue";
import RadioList from "@/components/List/RadioList.vue";
import RankingList from "@/components/List/RankingList.vue";
import SongList from "@/components/List/SongList.vue";
import VideoList from "@/components/List/VideoList.vue";
import { PageSectionType, type NormalizedPageSection } from "@/types/page";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  sections: NormalizedPageSection[];
  platform: string;
}>();

const router = useRouter();
const { t } = useI18n();

const routeNames: Partial<Record<number, string>> = {
  [PageSectionType.NewSongs]: "new-song",
  [PageSectionType.NewAlbums]: "new-album",
  [PageSectionType.Ranking]: "ranking-list",
};

const getDefaultTitle = (sectionType: number): string => {
  switch (sectionType) {
    case PageSectionType.NewSongs:
      return t("discover.new_song");
    case PageSectionType.NewAlbums:
      return t("discover.new_album");
    case PageSectionType.Ranking:
      return t("common.rank");
    default:
      return "";
  }
};

const displaySections = computed(() =>
  props.sections.map((section) => ({
    section,
    title: section.title || getDefaultTitle(section.section_type),
    routeName: routeNames[section.section_type],
  })),
);

const openMore = (routeName: string) => {
  router.push({
    name: routeName,
    query: { platform: props.platform },
  });
};
</script>

<style lang="scss" scoped>
.page-section-list,
.page-section {
  width: 100%;
  min-width: 0;
}

.page-section + .page-section {
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
