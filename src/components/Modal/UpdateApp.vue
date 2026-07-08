<template>
  <div class="update-app">
    <n-flex :size="10" class="version" align="center">
      <n-tag :bordered="false" type="primary">
        {{ packageJson?.version || "v0.0.0" }}
      </n-tag>
      <SvgIcon name="Right" />
      <n-tag :bordered="false" type="warning">
        {{ data?.version || "v0.0.0" }}
      </n-tag>
    </n-flex>
    <n-scrollbar style="max-height: 500px">
      <div v-if="data?.releaseNotes" class="markdown-body" v-html="data.releaseNotes" />
      <div v-else class="markdown-body">
        {{ t("modal.no_update_log") }}
      </div>
    </n-scrollbar>
    <n-flex class="menu" justify="end">
      <n-button strong secondary @click="emit('close')">
        {{ t("common.cancel") }}
      </n-button>
      <n-button type="warning" strong secondary @click="goDownload">
        {{ t("modal.click_download") }}
      </n-button>
      <n-button :loading="downloadStatus" type="primary" @click="startDownload">
        {{
          downloadStatus ? `${t("modal.downloading")} ${downloadProgress}%` : t("modal.update_now")
        }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import type { UpdateInfoType } from "@/types/main";
import packageJson from "@/../package.json";
import { useI18n } from "vue-i18n";
import "github-markdown-css/github-markdown.css";
const { t } = useI18n();

defineProps<{ data: UpdateInfoType }>();

const emit = defineEmits<{ close: [] }>();

// 下载更新数据
const downloadStatus = ref<boolean>(false);
const downloadProgress = ref<number>(0);

// 开始更新
const startDownload = async () => {
  downloadStatus.value = true;
  window.electron.ipcRenderer.send("start-download-update");
  // 监听状态
  window.electron.ipcRenderer.on("download-progress", (_, progress) => {
    downloadProgress.value = Number((progress?.percent || 0).toFixed(2));
  });
  // 更新错误
  window.electron.ipcRenderer.on("update-error", (_, error) => {
    downloadStatus.value = false;
    console.error("Error updating:", error);
    window.$message.error(t("message.update_error"));
  });
  // 更新完成
  window.electron.ipcRenderer.on("update-downloaded", () => {
    emit("close");
    downloadStatus.value = false;
    window.$message.success(t("message.update_download_complete"));
  });
};

// 前往下载
const goDownload = () => {
  emit("close");
  window.open(packageJson.github + "/releases", "_blank");
};
</script>

<style lang="scss" scoped>
.update-app {
  .version {
    margin-bottom: 20px;
    .n-tag {
      border-radius: 6px;
    }
    .time {
      margin-left: auto;
      font-size: 13px;
    }
  }
  .menu {
    margin-top: 20px;
  }
  .markdown-body {
    margin-top: 0 !important;
  }
}
</style>
