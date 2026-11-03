<template>
  <div v-if="isMygo" class="local-music-directory">
    <n-text class="local-list-tip">{{ t("setting.local.local_files_path") }}</n-text>
    <n-text v-if="filesSession?.persistenceError.value" role="alert">
      {{ t("setting.local.directory_persist_failed") }}
    </n-text>
    <n-text v-if="!ready" role="status">{{ t("setting.local.directory_unavailable") }}</n-text>
    <n-text v-if="feedback" role="status">{{ t(`setting.local.directory_${feedback}`) }}</n-text>
    <n-scrollbar style="max-height: 50vh">
      <n-list class="local-list" hoverable clickable bordered>
        <div v-if="!grants.length && !savedPaths.length" class="empty">
          <n-empty :description="t('local.none_folder')" />
        </div>
        <n-list-item v-for="path in savedPaths" :key="`saved:${path}`">
          <template #prefix><SvgIcon :size="20" name="Folder" /></template>
          <n-thing :title="path" />
          <template #suffix>
            <n-button
              :focusable="false"
              quaternary
              :disabled="!ready || busy"
              :title="t('common.delete')"
              :aria-label="t('common.delete')"
              @click="forgetSaved(path)"
            >
              <template #icon><SvgIcon :size="20" name="Delete" /></template>
            </n-button>
          </template>
        </n-list-item>
        <n-list-item v-for="grant in grants" :key="grant.token">
          <template #prefix><SvgIcon :size="20" name="Folder" /></template>
          <n-thing :title="grant.displayPath" />
          <template #suffix>
            <n-button
              data-directory-action="revoke"
              :focusable="false"
              quaternary
              :title="t('setting.local.directory_revoke')"
              :aria-label="t('setting.local.directory_revoke')"
              :disabled="!ready || busy"
              @click="revoke(grant.token)"
            >
              <template #icon><SvgIcon :size="20" name="Delete" /></template>
            </n-button>
          </template>
        </n-list-item>
      </n-list>
    </n-scrollbar>
    <n-flex justify="center" style="margin-top: 20px">
      <n-button
        class="add-path"
        strong
        secondary
        data-directory-action="choose"
        :disabled="!ready || busy"
        @click="choose"
      >
        <template #icon><SvgIcon name="FolderPlus" /></template>
        {{ t("local.add_folder") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { isMygo } from "@/utils/env";
import { createLocalDirectorySession } from "@/platform/localDirectorySession";
import { createLibraryDirectoryRecovery } from "@/platform/libraryDirectoryRecovery";
import { filesSession } from "@/platform/filesSession";
import { useSettingStore } from "@/stores";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const settingStore = useSettingStore();
const recovery = isMygo
  ? createLibraryDirectoryRecovery({
      read: () => settingStore.localFilesPath,
      write: (paths) => {
        settingStore.localFilesPath = paths;
      },
    })
  : undefined;
const directory = isMygo ? createLocalDirectorySession(undefined, recovery?.choose) : undefined;
const feedback = computed(() => directory?.feedback.value ?? "");
const ready = computed(() => directory?.ready.value ?? false);
const busy = computed(() => directory?.busy.value ?? false);
const grants = computed(() => directory?.grants.value ?? []);
const choose = () => directory?.choose();
const revoke = async (token: string) => {
  const owner = filesSession.value;
  const path = grants.value.find((grant) => grant.token === token)?.displayPath;
  const result = await directory?.revoke(token);
  if (
    path &&
    owner === filesSession.value &&
    result?.status === "completed" &&
    !grants.value.some((grant) => grant.token === token)
  ) {
    settingStore.localFilesPath = settingStore.localFilesPath.filter((item) => item !== path);
  }
};
const forgetSaved = async (path: string) => {
  const owner = filesSession.value;
  const result = await owner?.forgetSavedDirectory(path);
  if (owner !== filesSession.value) return;
  if (result?.status === "completed") {
    settingStore.localFilesPath = settingStore.localFilesPath.filter((item) => item !== path);
    if (settingStore.downloadPath === path) settingStore.downloadPath = "";
  } else window.$message.error(t("setting.local.directory_failed"));
};
const savedPaths = computed(() => [
  ...new Set([
    ...(recovery?.pendingPaths.value ?? []),
    ...(filesSession.value?.unavailableDirectories.value ?? []),
    ...(settingStore.downloadPath &&
    !grants.value.some((grant) => grant.displayPath === settingStore.downloadPath)
      ? [settingStore.downloadPath]
      : []),
  ]),
]);
</script>

<style scoped lang="scss">
.local-list-tip {
  display: block;
  margin-bottom: 12px;
  opacity: 0.8;
}
.local-list {
  :deep(.n-list-item__prefix) {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .empty {
    padding: 20px 0;
  }
}
</style>
