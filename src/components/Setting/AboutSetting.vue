<template>
  <div class="setting-type">
    <div class="set-list">
      <n-h3 prefix="bar">
        {{ t("setting.about.about_software") }}
      </n-h3>
      <n-card class="set-item">
        <n-flex align="center" class="about">
          <SvgIcon name="HEMusic" size="26" />
          <n-text class="logo-name"> HE-Music </n-text>
          <n-tag :bordered="false" size="small" type="primary">
            {{ packageJson.version }}
          </n-tag>
        </n-flex>
        <n-button
          :loading="statusStore.updateCheck"
          type="primary"
          strong
          secondary
          @click="checkUpdate"
        >
          {{
            statusStore.updateCheck
              ? t("setting.about.checking_update")
              : t("setting.about.check_update")
          }}
        </n-button>
      </n-card>
      <n-collapse-transition :show="!!updateData">
        <n-card class="set-item update-data">
          <n-flex class="version">
            <n-text>
              {{ t("setting.about.latest_version") }}
            </n-text>
            <n-tag :bordered="false" size="small" type="primary">
              {{ newVersion?.version || "v0.0.0" }}
            </n-tag>
            <n-tag v-if="newVersion?.prerelease" class="test" size="small" type="warning">
              {{ t("setting.about.beta_version") }}
            </n-tag>
            <n-text :depth="3" class="time">
              {{ newVersion?.time }}
            </n-text>
          </n-flex>
          <div class="markdown-body" @click="jumpLink" v-html="newVersion?.changelog" />
        </n-card>
      </n-collapse-transition>
    </div>
    <div class="set-list">
      <n-h3 prefix="bar"> {{ t("common.special_thanks") }} </n-h3>
      <n-flex :size="12" class="link">
        <n-card
          v-for="(item, index) in contributors"
          :key="index"
          class="link-item"
          hoverable
          @click="openLink(item.url)"
        >
          <n-flex vertical :gap="4">
            <n-text class="name" strong> {{ item.name }} </n-text>
            <n-text class="tip" :depth="3" style="font-size: 12px">
              {{ item.description }}
            </n-text>
          </n-flex>
        </n-card>
      </n-flex>
    </div>
    <div class="set-list">
      <n-h3 prefix="bar">
        {{ t("setting.about.community_and_news") }}
      </n-h3>
      <n-flex class="link">
        <n-card
          v-for="(item, index) in communityData"
          :key="index"
          class="link-item"
          hoverable
          @click="openLink(item.url)"
        >
          <SvgIcon :name="item.icon" :size="26" />
          <n-text class="name">
            {{ item.name }}
          </n-text>
        </n-card>
      </n-flex>
    </div>
    <div class="set-list">
      <n-h3 prefix="bar">
        {{ t("setting.about.history_version") }}
      </n-h3>
      <n-collapse-transition :show="oldVersion?.length > 0">
        <n-collapse accordion>
          <n-collapse-item
            v-for="(item, index) in oldVersion"
            :key="index"
            :title="item.version"
            :name="item.version"
          >
            <n-card class="set-item update-data">
              <n-flex class="version" justify="space-between">
                <n-tag :bordered="false" size="small" type="primary">
                  {{ item?.version || "v0.0.0" }}
                </n-tag>
                <n-text :depth="3" class="time">
                  {{ item?.time }}
                </n-text>
              </n-flex>
              <div class="markdown-body" @click="jumpLink" v-html="item?.changelog" />
            </n-card>
          </n-collapse-item>
        </n-collapse>
      </n-collapse-transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { UpdateLogType } from "@/types/main";
import { getUpdateLog, openLink } from "@/utils/helper";
import { debounce } from "lodash-es";
import { useStatusStore } from "@/stores";
import "github-markdown-css/github-markdown.css";
import packageJson from "@/../package.json";
import { useI18n } from "vue-i18n";
import { isElectron } from "@/utils/env";

const { t } = useI18n();
const statusStore = useStatusStore();

// 特别鸣谢
const contributors = [
  {
    name: "SPlayer",
    url: "https://github.com/imsyy/SPlayer",
    description: "SPlayer",
  },
  {
    name: "NeteaseCloudMusicApi",
    url: "https://github.com/Binaryify/NeteaseCloudMusicApi",
    description: "网易云音乐 API",
  },
  // https://github.com/neteasecloudmusicapienhanced/api-enhanced
  {
    name: "NeteaseCloudMusicApiEnhanced",
    url: "https://github.com/neteasecloudmusicapienhanced/api-enhanced",
    description: "网易云音乐 API 备份 + 增强",
  },
  {
    name: "YesPlayMusic",
    url: "https://github.com/qier222/YesPlayMusic",
    description: "高颜值的第三方网易云播放器",
  },
  {
    name: "UnblockNeteaseMusic",
    url: "https://github.com/UnblockNeteaseMusic/server",
    description: "Revive unavailable songs for Netease Cloud Music",
  },
  {
    name: "applemusic-like-lyrics",
    url: "https://github.com/Steve-xmh/applemusic-like-lyrics",
    description: "类 Apple Music 歌词显示组件库",
  },
];

// 社区数据
const communityData = [
  {
    name: "SPlayer",
    url: "https://github.com/imsyy/SPlayer",
    icon: "Github",
  },
  {
    name: "HE-Music",
    url: packageJson.github,
    icon: "Github",
  },
  {
    name: "HE-Music-Fluter",
    url: "https://github.com/he-music/HE-Music-Flutter",
    icon: "Github",
  },
  {
    name: computed(() => t("setting.about.official_blog")),
    url: packageJson.blog,
    icon: "RssFeed",
  },
];

// 更新日志数据
const updateData = ref<UpdateLogType[] | null>(null);

// 最新版本
const newVersion = computed<UpdateLogType | undefined>(() => updateData.value?.[0]);

// 历史版本
const oldVersion = computed<UpdateLogType[]>(() => {
  const oldData = updateData.value?.slice(1);
  return oldData ? oldData : [];
});

// 检查更新
const checkUpdate = debounce(
  () => {
    if (!isElectron) {
      window.open(packageJson.github + "/releases", "_blank");
      return;
    }
    statusStore.updateCheck = true;
    window.electron.ipcRenderer.send("check-update", true);
  },
  300,
  { leading: true, trailing: false },
);

// 链接跳转
const jumpLink = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  if (target.tagName !== "A") {
    return;
  }
  e.preventDefault();
  openLink((target as HTMLAnchorElement).href);
};

// 获取更新日志
const getUpdateData = async () => (updateData.value = await getUpdateLog());

onMounted(getUpdateData);
</script>

<style lang="scss" scoped>
.about {
  .logo-name {
    font-size: 16px;
  }
  .n-tag {
    border-radius: 6px;
  }
}
.update-data {
  :deep(.n-card__content) {
    flex-direction: column !important;
    align-items: normal !important;
  }
  .version {
    padding-left: 4px;
    .n-tag {
      pointer-events: none;
      border-radius: 6px;
    }
    .time {
      margin-left: auto;
      font-size: 13px;
    }
  }
}
.link {
  .link-item {
    max-width: 200px;
    border-radius: 8px;
    cursor: pointer;
    :deep(.n-card__content) {
      display: flex;
      align-items: center;
      padding: 12px;
    }
    .n-icon {
      margin-right: 6px;
    }
  }
}
</style>
