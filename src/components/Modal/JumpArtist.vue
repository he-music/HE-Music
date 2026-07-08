<!-- 歌手跳转 -->
<template>
  <div class="jump-artist">
    <Transition name="fade" mode="out-in">
      <div v-if="artistData?.length" class="ar-list">
        <n-alert v-if="typeof artist === 'string'" :show-icon="false">
          {{ t("modal.jump_string_artist_warning") }}
        </n-alert>
        <n-card
          v-for="(item, index) in artistData"
          :key="index"
          class="ar-item"
          hoverable
          @click="jumpArtist(item.id, platform)"
        >
          <n-avatar :src="'/images/artist.jpg?asset'" class="cover" round />
          <n-text class="name">
            {{ item.name }}
          </n-text>
        </n-card>
      </div>
      <div v-else class="ar-list">
        <n-skeleton class="ar-item" :repeat="2" text />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { SongInfo, SongInfoArtistInfo } from "@/types/main.hemusic";
import { usePlatformStore, useSettingStore } from "@/stores";
import { searchResultHemusic } from "@/api/search";
import { uniq } from "lodash-es";
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

// 获取歌手信息
const getArtistData = async () => {
  if (!props.artist) return;
  // 写入歌手信息
  const setArtistData = (data: any, name: string) => {
    if (!data) return;
    const filteredData = data
      .filter((ar: any) => ar.name === name)
      .map((ar: any) => ({
        id: ar.id,
        name: ar.name,
      }));
    artistData.value.push(...filteredData);
  };

  const platform = platformStore.platforms.find(
    (p) => p.feature_support_flag & FeatureSupportFlag.SearchSinger && p.status === 1,
  );
  if (typeof props.artist === "string") {
    let artists: string[] = [];
    // 是否有分割符
    const hasSeparator = settingStore.localSeparators.some((separator) =>
      (props.artist as string).includes(separator),
    );
    if (!hasSeparator) {
      const name = (props.artist as string).trim();
      const result = await searchResultHemusic(
        name,
        10,
        1,
        props.platform || platform?.id || "",
        "artist",
      );
      setArtistData(result.list, name);
    } else {
      // 遍历分割符，并分割歌手名字
      settingStore.localSeparators.forEach((separator) => {
        artists = artists.concat((props.artist as string).split(separator));
      });
      // 去重
      artists = uniq(
        artists
          .map((artist) => artist.trim())
          .filter((artist) => artist && artist !== props.artist),
      );
      // 获取歌手信息
      artists.map(async (name) => {
        const result = await searchResultHemusic(
          name,
          10,
          1,
          props.platform || platform?.id || "",
          "artist",
        );
        setArtistData(result.list, name);
      });
    }
  } else if (Array.isArray(props.artist)) {
    artistData.value = props.artist;
  }
};

// 跳转至歌手
const jumpArtist = (id: string, platform: string) => {
  if (!id || !platform) return;
  emit("close");
  router.push({ name: "artist", query: { id, platform } });
};

onMounted(getArtistData);
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
    .n-card__content {
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
