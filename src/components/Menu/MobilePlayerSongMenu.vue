<template>
  <n-drawer
    v-model:show="showDrawer"
    :auto-focus="false"
    placement="bottom"
    class="mobile-song-menu"
    height="70vh"
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
        <div class="menu-tool">
          <div class="menu-tool-item" @click.stop="handleAddToPlaylist(currentSong)">
            <n-button :focusable="false" :title="t('menu.add_to_playlist')" tertiary circle>
              <template #icon>
                <SvgIcon name="AddList" :size="24" />
              </template>
            </n-button>
            <div class="title">
              {{ t("menu.add_to_playlist") }}
            </div>
          </div>
          <div class="menu-tool-item" @click.stop="handleOpenAutoClose">
            <n-button :focusable="false" :title="t('common.auto_close')" tertiary circle @click="">
              <template #icon>
                <SvgIcon name="TimeAuto" :size="24" />
              </template>
            </n-button>
            <div class="title">
              {{
                stateStore.autoClose.enable
                  ? convertSecondsToTime(stateStore.autoClose.remainTime)
                  : t("common.auto_close")
              }}
            </div>
          </div>
          <div class="menu-tool-item" @click.stop="handleOpenChangeRate">
            <n-button :focusable="false" :title="t('common.play_rate')" tertiary circle>
              <template #icon>
                <SvgIcon name="PlayRate" :size="24" />
              </template>
            </n-button>
            <div class="title">
              {{ stateStore.playRate == 1 ? t("common.play_rate") : stateStore.playRate + "x" }}
            </div>
          </div>
        </div>
        <n-divider style="margin-bottom: 0; margin-top: 0" />
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
import { useStatusStore } from "@/stores";
import { useI18n } from "vue-i18n";
import { openAutoClose, openChangeRate, openPlaylistAdd } from "@/utils/modal";
import { convertSecondsToTime } from "@/utils/time";

const emit = defineEmits<{ clickQuality: [] }>();

const stateStore = useStatusStore();
const { getPlayerMenuOptions } = useSongMenu();
const { t } = useI18n();

const showDrawer = ref(false);
const currentSong = ref<SongInfo | null>(null);
const menuOptions = ref<DropdownOption[]>([]);

// 打开菜单
const open = (song: SongInfo) => {
  currentSong.value = song;
  menuOptions.value = getPlayerMenuOptions(song, emit);
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
  if (item.hideFullPlayer) {
    stateStore.showFullPlayer = false;
  }
};

const handleAddToPlaylist = (song: SongInfo | null) => {
  if (!song) return;
  showDrawer.value = false;
  openPlaylistAdd([song], !!song.path);
};

const handleOpenAutoClose = () => {
  showDrawer.value = false;
  openAutoClose();
};

const handleOpenChangeRate = () => {
  showDrawer.value = false;
  openChangeRate();
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
  .menu-content {
    .menu-tool {
      display: flex;
      align-items: center;
      padding: 8px 18px;
      justify-content: space-between;
      .menu-tool-item {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        gap: 2px;
        .n-button {
          width: 32px;
          height: 32px;
          -webkit-app-region: no-drag;
        }
        .title {
          font-size: 12px;
        }
      }
    }
  }
}
</style>
