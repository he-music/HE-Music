<template>
  <n-drawer
    v-model:show="showDrawer"
    :auto-focus="false"
    placement="bottom"
    class="mobile-song-menu"
    height="60vh"
  >
    <n-drawer-content
      :native-scrollbar="false"
      :header-style="{ padding: '16px 18px' }"
      :body-content-style="{ padding: 0 }"
      closable
    >
      <template #header>
        <div class="menu-header">
          <s-image :src="getSizeCover(currentSong)" class="cover" />
          <div class="info">
            <div class="name text-hidden">{{ currentSong?.name }}</div>
            <div class="artist text-hidden">{{ songArtist }}</div>
          </div>
        </div>
      </template>
      <div class="menu-content">
        <n-menu
          :options="menuOptions"
          :indent="18"
          :root-indent="18"
          @update:value="handleMenuClick"
        />
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { NMenu, type MenuOption, type DropdownOption } from "naive-ui";
import SImage from "@/components/UI/s-image.vue";
import { SongInfo } from "@/types/main.hemusic";
import songManager from "@/utils/songManager";
import { useSongMenu } from "@/composables/useSongMenu";
import { getSizeCover } from "@/utils/format";

const emit = defineEmits<{ removeSong: [index: SongInfo[]] }>();

const { getMenuOptions } = useSongMenu();

const showDrawer = ref(false);
const currentSong = ref<SongInfo | null>(null);
const menuOptions = ref<DropdownOption[]>([]);

// 打开菜单
const open = (
  song: SongInfo,
  index: number,
  playlist: {
    id: string;
    platform?: string;
    type?: string;
  } = {
    id: "",
    platform: "",
    type: "",
  },
) => {
  currentSong.value = song;
  menuOptions.value = getMenuOptions(song, index, playlist, emit);
  showDrawer.value = true;
};

// 歌手信息
const songArtist = computed(() => {
  if (!currentSong.value) return "";
  const info = songManager.getPlayerInfoObj(currentSong.value);
  return info?.artist || "未知艺术家";
});

const handleMenuClick = (_key: string, item: MenuOption) => {
  const onClick = item.props?.onClick;
  if (typeof onClick === "function") {
    (onClick as unknown as () => void)();
    showDrawer.value = false;
  }
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
    .info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 4px;
      .name {
        font-size: 16px;
        font-weight: 600;
        line-height: normal;
      }
      .artist {
        font-size: 13px;
        opacity: 0.6;
      }
    }
  }
}
</style>
