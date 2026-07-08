<!-- 歌曲列表 - 右键菜单 -->
<template>
  <n-dropdown
    :x="dropdownX"
    :y="dropdownY"
    :show="dropdownShow"
    :options="dropdownOptions"
    class="song-list-menu"
    placement="bottom-start"
    trigger="manual"
    size="large"
    @select="dropdownShow = false"
    @clickoutside="dropdownShow = false"
  />
</template>

<script setup lang="ts">
import { type DropdownOption, NFlex, NText } from "naive-ui";
import type { SongInfo } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
import { useSongMenu } from "@/composables/useSongMenu";
import SImage from "@/components/UI/s-image.vue";
import songManager from "@/utils/songManager";
import { getSizeCover } from "@/utils/format";
const { t } = useI18n();

const emit = defineEmits<{ removeSong: [index: SongInfo[]] }>();

// 右键菜单数据
const dropdownX = ref<number>(0);
const dropdownY = ref<number>(0);
const dropdownShow = ref<boolean>(false);
const dropdownOptions = ref<DropdownOption[]>([]);

const { getMenuOptions } = useSongMenu();

// 开启右键菜单
const openDropdown = (
  e: MouseEvent,
  _data: SongInfo[],
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
  try {
    e.preventDefault();
    dropdownShow.value = false;
    // 当前歌曲信息
    const songData = songManager.getPlayerInfoObj(song);
    const baseOptions = getMenuOptions(song, index, playlist, (event, args) => emit(event, args));
    // 头部信息
    const headerOption: DropdownOption = {
      key: "data",
      type: "render",
      render: () =>
        h(
          NFlex,
          {
            align: "center",
            wrap: false,
            class: "song-list-card",
          },
          {
            default: () => [
              h(SImage, { src: getSizeCover(song) }),
              h(
                NFlex,
                { vertical: true, size: 0 },
                {
                  default: () => [
                    h(NText, { class: "text-hidden", depth: 1 }, { default: () => songData?.name }),
                    h(
                      NText,
                      { depth: 3, class: "text-hidden", style: { fontSize: "12px" } },
                      { default: () => songData?.artist },
                    ),
                  ],
                },
              ),
            ],
          },
        ),
    };
    nextTick().then(() => {
      dropdownOptions.value = [
        headerOption,
        { key: "header-line", type: "divider" },
        ...baseOptions,
      ];
      // 显示菜单
      dropdownX.value = e.clientX;
      dropdownY.value = e.clientY;
      dropdownShow.value = true;
    });
  } catch (error) {
    console.error("右键菜单出现异常：", error);
    window.$message.error(t("message.right_click_menu_error"));
  }
};

defineExpose({ openDropdown });
</script>

<style lang="scss">
.delete-mata {
  display: flex;
}
.song-list-card {
  width: 100%;
  max-width: 180px;
  padding: 4px 10px;
  .s-image {
    border-radius: 6px;
    overflow: hidden;
    width: 40px;
    height: 40px;
    min-width: 40px;
  }
}
</style>
