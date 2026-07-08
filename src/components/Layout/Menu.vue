<!-- 主菜单 -->
<template>
  <n-menu
    ref="menuRef"
    v-model:value="menuActiveKey"
    :class="{ cover: settingStore.menuShowCover }"
    :indent="0"
    :root-indent="26"
    :collapsed="statusStore.menuCollapsed && isDesktop"
    :collapsed-width="64"
    :collapsed-icon-size="22"
    :default-expand-all="true"
    :options="menuOptions"
    :render-label="renderMenuLabel"
    @update:value="menuUpdate"
  />
</template>

<script setup lang="ts">
import {
  type MenuGroupOption,
  type MenuInst,
  type MenuOption,
  NAvatar,
  NButton,
  NEllipsis,
  NText,
} from "naive-ui";
import { useMobile } from "@/composables/useMobile";
import { useDataStore, useSettingStore, useStatusStore } from "@/stores";
import { RouterLink, useRouter } from "vue-router";
import { renderIcon } from "@/utils/helper";
import { isElectron } from "@/utils/env";
import { openCreatePlaylist } from "@/utils/modal";
import { useI18n } from "vue-i18n";
import type {
  PlaylistInfo,
  UserFavouritePlaylistInfo,
  UserPlaylistInfo,
} from "@/types/main.hemusic";

const router = useRouter();
const dataStore = useDataStore();
const statusStore = useStatusStore();
const settingStore = useSettingStore();

const { t } = useI18n();
const { isDesktop } = useMobile();

const emit = defineEmits<{ (e: "menu-click", key: string): void }>();
// 菜单数据
const menuRef = ref<MenuInst | null>(null);
const menuActiveKey = ref<string | number>((router.currentRoute.value.name as string) || "home");

// 菜单内容
const menuOptions = computed<MenuOption[] | MenuGroupOption[]>(() => {
  return settingStore.useOnlineService
    ? [
        // {
        //   key: "home",
        //   link: "home",
        //   label: "为我推荐",
        //   icon: renderIcon("Home", {
        //     style: {
        //       transform: "translateY(-1px)",
        //     },
        //   }),
        // },
        {
          key: "discover",
          link: "discover",
          label: t("nav.discover"),
          icon: renderIcon("Discover", {
            style: {
              transform: "translateY(-1px)",
            },
          }),
        },
        {
          key: "playlist-square",
          link: "playlist-square",
          label: t("nav.playlist_square"),
          icon: renderIcon("Square", {
            style: {
              transform: "translateY(-1px)",
            },
          }),
        },
        {
          key: "ranking-list",
          link: "ranking-list",
          label: t("common.rank"),
          icon: renderIcon("TopList", {
            style: {
              transform: "translateY(-1px)",
            },
          }),
        },
        {
          key: "artists",
          link: "artists",
          label: t("common.artists"),
          icon: renderIcon("Artist", {
            style: {
              transform: "translateY(-1px)",
            },
          }),
        },
        {
          key: "videos",
          link: "videos",
          label: t("common.videos"),
          icon: renderIcon("Video", {
            style: {
              transform: "translateY(-1px)",
            },
          }),
        },
        {
          key: "radios",
          link: "radios",
          label: t("common.radios"),
          icon: renderIcon("Radio", {
            style: {
              transform: "translateY(-1px)",
            },
          }),
        },
        {
          key: "divider",
          type: "divider",
        },
        // {
        //   key: "like-songs",
        //   link: "like-songs",
        //   label: "我喜欢的音乐",
        //   icon: renderIcon("Favorite"),
        // },
        {
          key: "like",
          link: "like",
          label: t("nav.my_collection"),
          icon: renderIcon("Star"),
        },
        {
          key: "download",
          label: t("nav.download_manager"),
          show: isElectron,
          icon: renderIcon("Download"),
        },
        {
          key: "local",
          link: "local",
          label: t("common.local_music"),
          show: isElectron,
          icon: renderIcon("FolderMusic"),
        },
        {
          key: "history",
          link: "history",
          label: t("nav.play_history"),
          icon: renderIcon("History"),
        },
        {
          key: "divider-two",
          type: "divider",
        },
        // 创建的歌单
        {
          key: "user-playlist",
          icon: statusStore.menuCollapsed ? renderIcon("PlaylistAdd") : undefined,
          label: () =>
            h("div", { class: "user-list" }, [
              h(NText, { depth: 3 }, () => [t("nav.created_playlist")]),
              h(NButton, {
                type: "tertiary",
                round: true,
                strong: true,
                secondary: true,
                renderIcon: renderIcon("Add"),
                onclick: (event: Event) => {
                  event.stopPropagation();
                  openCreatePlaylist();
                },
              }),
            ]),
          children: [...createPlaylist.value],
        },
        // 收藏的歌单
        {
          key: "liked-playlists",
          icon: statusStore.menuCollapsed ? renderIcon("PlaylistAddCheck") : undefined,
          label: () =>
            h(
              "div",
              { class: "user-list" },
              h(NText, { depth: 3 }, () => [t("nav.collected_playlist")]),
            ),
          children: [...likedPlaylist.value],
        },
      ]
    : [];
});

// 生成歌单列表
const renderUserPlaylist = (playlist: UserPlaylistInfo[], showCover: boolean) => {
  return playlist.map((playlist) => ({
    key: playlist.id,
    id: playlist.id,
    type: "user-playlist",
    label: () =>
      showCover
        ? h("div", { class: "pl-cover" }, [
            h(NAvatar, {
              src: playlist.cover,
              fallbackSrc: "/images/album.jpg?asset",
              lazy: true,
            }),
            h(NEllipsis, null, () =>
              playlist.is_default == 1 ? t("playlist.my_favorite_music") : playlist.name,
            ),
          ])
        : h(NEllipsis, null, () =>
            playlist.is_default == 1 ? t("playlist.my_favorite_music") : playlist.name,
          ),
    icon: showCover ? undefined : renderIcon("PlayList"),
  }));
};

// 生成歌单列表
const renderPlaylist = (
  playlist: PlaylistInfo[] | UserFavouritePlaylistInfo[],
  showCover: boolean,
) => {
  return playlist.map((playlist) => ({
    key: `${playlist.platform}-${playlist.id}`,
    id: playlist.id,
    type: "playlist",
    platform: playlist.platform,
    label: () =>
      showCover
        ? h("div", { class: "pl-cover" }, [
            h(NAvatar, {
              src: playlist.cover,
              fallbackSrc: "/images/album.jpg?asset",
              lazy: true,
            }),
            h(NEllipsis, null, () => playlist.name),
          ])
        : h(NEllipsis, null, () => playlist.name),
    icon: showCover ? undefined : renderIcon("PlayList"),
  }));
};

// 创建的歌单
const createPlaylist = computed<MenuOption[]>(() => {
  const list = dataStore.userCreatedPlaylist;
  return renderUserPlaylist(list, settingStore.menuShowCover);
});

// 收藏的歌单
const likedPlaylist = computed<MenuOption[]>(() => {
  return renderPlaylist(dataStore.userLikeData.playlists, settingStore.menuShowCover);
});

// 渲染菜单路由
const renderMenuLabel = (option: MenuOption) => {
  // 路由链接
  if ("link" in option) {
    return h(RouterLink, { to: { name: option.link as string } }, () => option.label as string);
  }
  return typeof option.label === "function" ? option.label() : (option.label as string);
};

// 菜单项更改
const menuUpdate = (key: string, item: MenuOption) => {
  emit("menu-click", key);
  if (item.platform) {
    router.push({
      name: (item.type as string) || "",
      query: { id: item.id as string, platform: item.platform as string },
    });
  } else if ((item.type as string) === "user-playlist") {
    router.push({
      name: (item.type as string) || "",
      query: { id: item.id as string },
    });
  } else {
    switch (key) {
      case "download":
        router.push({
          name:
            dataStore.downloadingSongs.length > 0 ? "download-downloading" : "download-downloaded",
        });
        break;
    }
  }
};

// 选中菜单项
const checkMenuItem = () => {
  // 当前路由名称
  let routerName =
    (router.currentRoute.value.matched?.[0]?.name as string) ||
    (router.currentRoute.value?.name as string);
  if (!routerName) return;
  // 处理本地歌曲子路由
  if (routerName.startsWith("local-")) {
    routerName = "local";
  }
  // 处理收藏子路由
  if (routerName.startsWith("like-")) {
    routerName = "like";
  }
  // 处理下载子路由
  if (routerName.startsWith("download-")) {
    routerName = "download";
  }
  // 显示菜单
  menuRef.value?.showOption(routerName);
  // 高亮菜单
  switch (routerName) {
    case "playlist": {
      // 获取歌单 id
      const playlistId = router.currentRoute.value.query.id as string;
      const playlistPlatform = router.currentRoute.value.query.platform as string;
      // 是否处于用户歌单
      const isUserPlaylist = dataStore.userLikeData.playlists.some(
        (playlist) => playlist?.id === playlistId && playlist.platform === playlistPlatform,
      );
      if (playlistId)
        menuActiveKey.value = isUserPlaylist ? `${playlistPlatform}-${playlistId}` : "home";
      menuRef.value?.showOption(playlistId);
      break;
    }
    case "user-playlist": {
      const playlistId = router.currentRoute.value.query.id as string;
      menuActiveKey.value = playlistId;
      menuRef.value?.showOption(playlistId);
      break;
    }
    default:
      menuActiveKey.value = routerName;
      break;
  }
};

// 监听路由
watch(
  () => [
    router.currentRoute.value,
    dataStore.userLikeData.playlists,
    dataStore.userCreatedPlaylist,
  ],
  () => checkMenuItem(),
);
</script>

<style lang="scss" scoped>
.n-menu {
  padding-bottom: 14px;
  :deep(.n-menu-item) {
    .n-menu-item-content {
      &::before {
        border-left: 4px solid transparent;
        transition:
          border 0.3s var(--n-bezier),
          background-color 0.3s var(--n-bezier);
      }
      &.n-menu-item-content--selected {
        .n-text {
          color: var(--primary-hex);
        }
        &::before {
          border-left-color: var(--n-item-text-color-active);
        }
      }
    }
  }
  &.cover {
    :deep(.n-submenu-children) {
      --n-item-height: 50px;
    }
  }
}
</style>

<style lang="scss">
.user-liked {
  display: flex;
  align-items: center;
  justify-content: space-between;
  .n-button {
    margin-left: 12px;
    --n-height: 30px;
    --n-padding: 0 16px;
    --n-icon-size: 20px;
  }
}
.user-list {
  display: flex;
  align-items: center;
  .n-text {
    font-size: 0.93em;
  }
  .n-button {
    margin-left: 12px;
    --n-height: 22px;
    --n-padding: 0 12px;
    --n-icon-size: 12px;
  }
}
.pl-cover {
  display: flex;
  align-items: center;
  .n-avatar {
    width: 34px;
    height: 34px;
    min-width: 34px;
    margin-right: 12px;
    border-radius: 8px;
  }
}
.mb-menu {
  width: 26px;
  height: 26px;
}
</style>
