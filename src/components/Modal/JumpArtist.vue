<!-- 歌手跳转 -->
<template>
  <div class="jump-artist">
    <Transition name="fade" mode="out-in">
      <div v-if="artistData?.length" class="ar-list">
        <n-alert v-if="typeof artist === 'string'" :show-icon="false">
          {{ t("modal.jump_string_artist_warning") }}
        </n-alert>
        <n-card
          v-for="item in artistData"
          :key="item.id"
          class="ar-item"
          hoverable
          @click="jumpArtist(item.id, artistPlatform)"
        >
          <n-avatar :src="'/images/artist.jpg?asset'" class="cover" round />
          <n-text class="name">
            {{ item.name }}
          </n-text>
        </n-card>
      </div>
      <div v-else class="ar-list">
        <n-skeleton v-if="loading" class="ar-item" :repeat="2" text />
        <n-empty v-else />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { SongInfo, SongInfoArtistInfo } from "@/types/main.hemusic";
import { usePlatformStore, useSettingStore } from "@/stores";
import { searchResultHemusic } from "@/api/search";
import { splitArtistNames } from "@/utils/songGroup";
import { FeatureSupportFlag } from "@/api/platform";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const settingStore = useSettingStore();
const platformStore = usePlatformStore();

const props = defineProps<{
  artist: SongInfo["artists"];
  platform: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const router = useRouter();

const artistData = ref<SongInfoArtistInfo[]>([]);
const loading = ref(true);
const artistPlatform = computed(
  () =>
    props.platform ||
    platformStore.platforms.find(
      (item) => item.feature_support_flag & FeatureSupportFlag.SearchSinger && item.status === 1,
    )?.id ||
    "",
);

watch(
  [() => props.artist, artistPlatform, () => settingStore.localSeparators],
  async ([artist, platform], _, onCleanup) => {
    let active = true;
    onCleanup(() => (active = false));
    artistData.value = [];
    loading.value = true;
    if (Array.isArray(artist)) {
      artistData.value = artist;
      loading.value = false;
      return;
    }
    const names = splitArtistNames(artist, settingStore.localSeparators);
    if (!platform || names.length === 0) {
      loading.value = false;
      return;
    }

    const results = await Promise.allSettled(
      names.map(async (name) => {
        const result: { list: SongInfoArtistInfo[] } = await searchResultHemusic(
          name,
          10,
          1,
          platform,
          "artist",
        );
        return result.list.filter((item) => item.name === name);
      }),
    );
    if (!active) return;
    const artists = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    artistData.value = [...new Map(artists.map((item) => [item.id, item])).values()];
    loading.value = false;
  },
  { immediate: true },
);

// 跳转至歌手
const jumpArtist = (id: string, platform: string) => {
  if (!id || !platform) return;
  emit("close");
  router.push({ name: "artist", query: { id, platform } });
};
</script>

<style lang="scss" scoped>
.ar-list {
  .n-alert {
    margin-bottom: 12px;
  }
  :deep(.ar-item) {
    height: 60px;
    margin-bottom: 12px;
    border-radius: 12px;
    cursor: pointer;
    &:last-child {
      margin-bottom: 0;
    }
    .n-card-content {
      padding: 12px 16px;
      display: flex;
      align-items: center;
    }
    .cover {
      margin-right: 8px;
    }
    .name {
      font-size: 16px;
    }
    &:hover {
      border-color: rgba(var(--primary), 0.58);
    }
  }
}
</style>
