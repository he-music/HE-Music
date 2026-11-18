<template>
  <n-drawer
    v-model:show="showDrawer"
    :auto-focus="false"
    placement="bottom"
    class="mobile-song-menu"
    height="50vh"
  >
    <n-drawer-content
      :native-scrollbar="false"
      :header-style="{ padding: '16px 18px' }"
      :body-content-style="{ padding: 0 }"
      closable
    >
      <template #header>
        <div class="menu-header">
          {{ t("common.song_quality") }}
        </div>
      </template>
      <div class="menu-content">
        <n-menu
          :options="menuOptions"
          :indent="18"
          :root-indent="18"
          :value="selectedQuality"
          @update:value="handleMenuClick"
        />
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { NMenu } from "naive-ui";
import { SongInfo } from "@/types/main.hemusic";
import { useSongMenu } from "@/composables/useSongMenu";
const { getQualityMenuOptions } = useSongMenu();
import { useStatusStore } from "@/stores";
import { useI18n } from "vue-i18n";
import { useOverlayBack } from "@/composables/useOverlayBack";
import { usePlayer } from "@/utils/player";

const { t } = useI18n();
const statusStore = useStatusStore();
const player = usePlayer();

const showDrawer = ref(false);
useOverlayBack(showDrawer, () => {
  showDrawer.value = false;
});
const currentSong = ref<SongInfo | null>(null);
const menuOptions = computed(() =>
  currentSong.value ? getQualityMenuOptions(currentSong.value) : [],
);

const selectedQuality = computed<string>(() => statusStore.playQuality);

// 打开菜单
const open = (song: SongInfo) => {
  currentSong.value = song;
  showDrawer.value = true;
};

const handleMenuClick = (quality: string) => {
  if (currentSong.value?.path) return;
  player.changeQuality(quality);
  showDrawer.value = false;
};
defineExpose({ open });
</script>

<style lang="scss" scoped>
.mobile-song-menu {
  border-radius: 16px 16px 0 0;
  overflow: hidden;
  .menu-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-right: 20px;
    .cover {
      width: 48px;
      height: 48px;
      border-radius: 8px;
      flex-shrink: 0;
      overflow: hidden;
    }
  }
}
</style>
