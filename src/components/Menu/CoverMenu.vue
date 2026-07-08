<template>
  <n-dropdown
    :x="dropdownX"
    :y="dropdownY"
    :show="dropdownShow"
    :options="dropdownOptions"
    class="search-inp-menu"
    placement="bottom-start"
    trigger="manual"
    @select="dropdownShow = false"
    @clickoutside="dropdownShow = false"
  />
</template>

<script setup lang="ts">
import type { DropdownOption } from "naive-ui";
import { copyData, renderIcon } from "@/utils/helper";
import { useMusicStore, useStatusStore } from "@/stores";
import type { CoverType } from "@/types/main.hemusic";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const emit = defineEmits<{
  // 直接搜索
  toPlay: [item: CoverType];
}>();

const router = useRouter();
const musicStore = useMusicStore();
const statusStore = useStatusStore();

// 右键菜单数据
const dropdownX = ref<number>(0);
const dropdownY = ref<number>(0);
const dropdownShow = ref<boolean>(false);
const dropdownOptions = ref<DropdownOption[]>([]);
// 开启右键菜单
const openDropdown = async (
  e: MouseEvent,
  item: CoverType,
  type: "playlist" | "album" | "video" | "ranking",
) => {
  try {
    console.log(item, type);
    e.preventDefault();
    dropdownShow.value = false;
    // 生成菜单
    nextTick().then(() => {
      dropdownOptions.value = [
        {
          key: "open",
          label: t("common.view_detail"),
          props: {
            onClick: () =>
              router.push({
                name: type,
                query: { id: item.id, platform: item.platform },
              }),
          },
          icon: renderIcon("Eye"),
        },
        {
          key: "play",
          label: t("common.play"),
          show:
            !musicStore.isPlayingPlaylist(item.id, item.platform, type) || !statusStore.playStatus,
          props: {
            onClick: () => emit("toPlay", item),
          },
          icon: renderIcon("Play"),
        },
        {
          key: "pause",
          label: t("common.pause"),
          show:
            musicStore.isPlayingPlaylist(item.id, item.platform, type) && statusStore.playStatus,
          props: {
            onClick: () => emit("toPlay", item),
          },
          icon: renderIcon("Pause"),
        },
        {
          key: "copy-name",
          label: `${t("common.copy_name")}`,
          props: {
            onClick: () => copyData(item.name),
          },
          icon: renderIcon("Copy", { size: 18 }),
        },
        {
          key: "copy-id",
          label: `${t("common.copy_id")}`,
          props: {
            onClick: () => copyData(item.id),
          },
          icon: renderIcon("Copy", { size: 18 }),
        },
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
