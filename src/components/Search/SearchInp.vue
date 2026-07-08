<template>
  <div :class="['search', { focus: statusStore.searchFocus }]">
    <!-- 搜索框 -->
    <n-input
      ref="searchInputRef"
      v-model:value="statusStore.searchInputValue"
      :input-props="{ autocomplete: 'off' }"
      :placeholder="searchPlaceholder"
      :allow-input="noSideSpace"
      class="search-input"
      round
      clearable
      @focus="searchInputToFocus"
      @keyup.enter="toSearch(statusStore.searchInputValue)"
      @contextmenu.stop="searchInpMenuRef?.openDropdown($event)"
      @click.stop
    >
      <template #prefix>
        <SvgIcon :size="18" name="Search" />
      </template>
    </n-input>
    <!-- 搜索框遮罩 -->
    <Transition name="fade" mode="out-in">
      <div
        v-show="statusStore.searchFocus"
        class="search-mask"
        @click.stop="statusStore.searchFocus = false"
      />
    </Transition>
    <!-- 默认内容 -->
    <SearchDefault v-if="settingStore.useOnlineService" @to-search="toSearch" />
    <!-- 搜索结果 -->
    <SearchSuggest @to-search="toSearch" />
    <!-- 右键菜单 -->
    <SearchInpMenu ref="searchInpMenuRef" @to-search="toSearch" />
  </div>
</template>

<script setup lang="ts">
import { useDataStore, usePlatformStore, useSettingStore, useStatusStore } from "@/stores";
import { searchDefault } from "@/api/search";
import SearchInpMenu from "@/components/Menu/SearchInpMenu.vue";
import SearchDefault from "@/components/Search/SearchDefault.vue";
import SearchSuggest from "@/components/Search/SearchSuggest.vue";
import type { SearchDefaultInfo } from "@/types/main.hemusic";
import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { FeatureSupportFlag } from "@/api/platform";
const { t, locale } = useI18n();

const router = useRouter();
const dataStore = useDataStore();
const statusStore = useStatusStore();
const platformStore = usePlatformStore();
const settingStore = useSettingStore();

// 右键菜单
const searchInpMenuRef = ref<InstanceType<typeof SearchInpMenu> | null>(null);
let searchDefaultList: SearchDefaultInfo[] = [];
let searchDefaultIndex: number = -1;

// 搜索框数据
const searchInputRef = ref<HTMLInputElement | null>(null);
const searchPlaceholder = ref<string>(t("search.placeholder"));
const searchRealKeyword = ref<string>("");

// 搜索框输入限制
const noSideSpace = (value: string) => !value.startsWith(" ");

// 搜索框 focus
const searchInputToFocus = () => {
  // searchInpRef.value?.focus();
  statusStore.searchFocus = true;
};

// 添加搜索历史
const setSearchHistory = (keyword: string) => {
  // 去除空格
  keyword = keyword.trim();
  if (!keyword) return;
  const index = dataStore.searchHistory.indexOf(keyword);
  if (index !== -1) {
    dataStore.searchHistory.splice(index, 1);
  }
  dataStore.searchHistory.unshift(keyword);
  if (dataStore.searchHistory.length > 30) {
    dataStore.searchHistory.length = 30;
  }
};

// reloadPlaceholder 重新加载
const reloadPlaceholder = async () => {
  try {
    const platform = platformStore.platforms.find(
      (item) =>
        item.feature_support_flag & FeatureSupportFlag.GetSearchDefault && item.status === 1,
    );
    if (!platform) {
      return;
    }
    const result = await searchDefault(platform?.id || "");
    searchDefaultList = result.list || [];
  } catch (error) {
    console.error("搜索关键词获取失败：", error);
    searchPlaceholder.value = t("search.placeholder");
  }
};

// 更换搜索框关键词
const updatePlaceholder = () => {
  if (searchDefaultList.length > 0) {
    searchDefaultIndex = (searchDefaultIndex + 1) % searchDefaultList.length;
    const result = searchDefaultList[searchDefaultIndex];
    searchPlaceholder.value = result.key + " " + result.description;
    searchRealKeyword.value = result.key;
    return;
  }
};

// 前往搜索
const toSearch = async (key: any, type: string = "keyword") => {
  // 未输入内容且不存在推荐
  if (!key && searchPlaceholder.value === t("search.placeholder")) return;
  if (!key && searchPlaceholder.value !== t("search.placeholder") && searchRealKeyword.value) {
    key = searchRealKeyword.value?.trim();
  }
  // 关闭搜索框
  statusStore.searchFocus = false;
  searchInputRef.value?.blur();

  // 前往搜索
  switch (type) {
    case "keyword":
      router.push({
        name: "search",
        query: { keyword: key },
      });
      setSearchHistory(key);
      break;
    // case "songs": {
    //   const result = await songDetail(key?.id);
    //   const song = formatSongsList(result.songs)[0];
    //   player.addNextSong(song, true);
    //   break;
    // }
    case "playlists":
      router.push({
        name: "playlist",
        query: { id: key?.id },
      });
      break;
    case "artists":
      router.push({
        name: "artist",
        query: { id: key?.id },
      });
      break;
    case "albums":
      router.push({
        name: "album",
        query: { id: key?.id },
      });
      break;
    default:
      break;
  }
};

const watcher = watch(
  () => platformStore.platforms,
  async () => {
    watcher.stop();
    if (searchDefaultList.length != 0) {
      return;
    }
    await reloadPlaceholder();
    updatePlaceholder();
  },
);

watch(locale, () => {
  if (searchDefaultList.length !== 0) {
    return;
  }
  searchPlaceholder.value = t("search.placeholder");
});

onMounted(async () => {
  await reloadPlaceholder();

  updatePlaceholder();
  // 每分钟更新
  useIntervalFn(reloadPlaceholder, 600 * 1000);
  useIntervalFn(updatePlaceholder, 60 * 1000);
});
</script>

<style lang="scss" scoped>
.search {
  position: absolute;
  left: 0;
  -webkit-app-region: no-drag;
  transition:
    left 0.3s,
    width 0.3s;
  .search-input {
    width: 200px;
    height: 40px;
    border-radius: 50px;
    transition:
      background-color 0.3s var(--n-bezier),
      width 0.3s var(--n-bezier);
    z-index: 101;
    :deep(input) {
      height: 100%;
      width: 100%;
    }
  }
  &.focus {
    .search-input {
      width: 300px;
    }
  }
  @media (max-width: 768px) {
    width: calc(100% - 150px);
    .search-input {
      width: 100%;
    }
    &.focus {
      left: -52px;
      width: calc(100% + 52px);
      .search-input {
        width: 100%;
      }
    }
  }
  .search-mask {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 100;
    background-color: #00000040;
    backdrop-filter: blur(20px);
    -webkit-app-region: no-drag;
  }
}
</style>
