<template>
  <div class="toplists">
    <Transition name="fade" mode="out-in">
      <div v-if="!loading" class="official-list">
        <n-divider v-if="groupWithSong">
          {{ groupWithSong.name }}
        </n-divider>
        <n-grid v-if="groupWithSong" cols="1 600:2 1000:3" x-gap="20" y-gap="20">
          <n-gi v-for="(item, index) in groupWithSong.rankings" :key="index">
            <SongListCard
              :cover="item.cover"
              :title="item.name"
              :height="160"
              size="normal"
              @click="
                router.push({ name: 'ranking', query: { id: item.id, platform: item.platform } })
              "
            >
              <template #info>
                <div
                  v-for="(song, songIndex) in item.songs"
                  :key="songIndex"
                  class="song-item text-hidden"
                >
                  <n-text class="name"> {{ songIndex + 1 }}. {{ song.name }} </n-text>
                  <n-text v-if="Array.isArray(song.artists)" class="desc" depth="3">
                    {{ song.artists?.[0]?.name }}
                  </n-text>
                  <n-text v-else class="desc" depth="3">
                    {{ song.artists || t("common.unknown_artist") }}
                  </n-text>
                </div>
              </template>
            </SongListCard>
          </n-gi>
        </n-grid>

        <div v-for="(item, idx) in topListData || []" :key="idx">
          <n-divider style="margin-bottom: 0">
            {{ item.name }}
          </n-divider>
          <RankingList :data="item.rankings" />
        </div>
      </div>
      <div v-else class="official-list">
        <n-grid cols="1 600:2 1000:3" x-gap="20" y-gap="20">
          <n-gi v-for="item in 4" :key="item">
            <n-card class="loading">
              <n-skeleton class="cover" />
              <div class="desc">
                <n-skeleton text round :repeat="3" />
              </div>
            </n-card>
          </n-gi>
        </n-grid>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { RankingInfo } from "@/types/main.hemusic";
import { listRankings } from "@/api/playlist";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const router = useRouter();

const props = defineProps<{
  platform: string;
}>();

const loading = ref<boolean>(true);
const groupWithSong = ref<{
  name: string;
  rankings: RankingInfo[];
}>();

// 排行榜数据
const topListData = ref<
  {
    name: string;
    rankings: RankingInfo[];
  }[]
>();

// 获取排行榜数据
const getTopPlaylistData = async () => {
  loading.value = true;
  const { groups = [] } = await listRankings(props.platform);

  if (groups?.[0].rankings?.[0].songs?.length > 0) {
    groupWithSong.value = groups[0];
    groups.shift();
    topListData.value = groups;
  } else {
    topListData.value = groups;
  }

  loading.value = false;
};

onMounted(getTopPlaylistData);
</script>

<style lang="scss" scoped>
.toplists {
  .song-item {
    .desc {
      &::before {
        content: "-";
        margin: 0 4px;
      }
    }
  }
  .loading {
    height: 160px;
    border-radius: 12px;
    cursor: pointer;
    :deep(.n-card__content) {
      display: flex;
      height: 100%;
      padding: 16px;
    }
    .cover {
      height: 100%;
      width: auto;
      border-radius: 8px;
      aspect-ratio: 1/1;
      margin-right: 20px;
    }
    .desc {
      display: flex;
      flex-direction: column;
      justify-content: space-evenly;
      width: 100%;
      :deep(.n-skeleton) {
        height: 20px;
      }
    }
  }
}
</style>
