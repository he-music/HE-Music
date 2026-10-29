<template>
  <div v-if="isElectron" class="local-music-directory">
    <n-text class="local-list-tip">
      {{ t("setting.local.local_files_path") }}
    </n-text>
    <n-scrollbar style="max-height: 50vh">
      <n-list class="local-list" hoverable clickable bordered>
        <div v-if="!settingStore.localFilesPath.length" class="empty">
          <n-empty :description="t('local.none_folder')" />
        </div>
        <n-list-item v-for="(path, index) in settingStore.localFilesPath" :key="index">
          <template #prefix>
            <SvgIcon :size="20" name="Folder" />
          </template>
          <template #suffix>
            <n-button :focusable="false" quaternary @click="changeLocalPath(index)">
              <template #icon>
                <SvgIcon :size="20" name="Delete" />
              </template>
            </n-button>
          </template>
          <n-thing :title="path" />
        </n-list-item>
      </n-list>
    </n-scrollbar>
    <n-flex justify="center" style="margin-top: 20px">
      <n-button class="add-path" strong secondary @click="changeLocalPath()">
        <template #icon>
          <SvgIcon name="FolderPlus" />
        </template>
        {{ t("local.add_folder") }}
      </n-button>
    </n-flex>
  </div>
  <div v-else-if="isMygo" class="local-music-directory">
    <n-text class="local-list-tip">{{ t("setting.local.directory_scope") }}</n-text>
    <n-text class="local-list-tip">{{ t("setting.local.directory_restart") }}</n-text>
    <n-text v-if="filesSession?.persistenceError.value" role="alert">{{
      t("setting.local.directory_persist_failed")
    }}</n-text>
    <n-text v-if="!ready" role="status">{{ t("setting.local.directory_unavailable") }}</n-text>
    <n-text v-if="feedback" role="status">{{ t(`setting.local.directory_${feedback}`) }}</n-text>
    <section v-if="savedPaths.length">
      <n-text>{{ t("mygo.library.pending") }}</n-text>
      <n-text>{{ t("setting.local.directory_reselect") }}</n-text>
      <p v-for="path in savedPaths" :key="path">
        {{ path }}
        <n-button :disabled="!ready || busy" @click="forgetSaved(path)">{{
          t("common.delete")
        }}</n-button>
      </p>
    </section>
    <p v-if="suggestion">{{ t("setting.local.directory_suggestion") }}: {{ suggestion }}</p>
    <n-scrollbar style="max-height: 50vh">
      <n-list class="local-list" bordered>
        <n-empty v-if="!grants.length" :description="t('local.none_folder')" />
        <n-list-item v-for="grant in grants" :key="grant.token">
          <n-text>{{ grant.displayPath }}</n-text>
          <template #suffix>
            <n-button
              data-directory-action="revoke"
              :disabled="!ready || busy"
              @click="revoke(grant.token)"
            >
              {{ t("setting.local.directory_revoke") }}
            </n-button>
          </template>
        </n-list-item>
      </n-list>
    </n-scrollbar>
    <n-flex justify="center" style="margin-top: 20px">
      <n-button data-directory-action="choose" :disabled="!ready || busy" @click="choose">
        {{ t("setting.local.directory_choose") }}
      </n-button>
      <n-button data-directory-action="default" :disabled="!ready || busy" @click="showDefault">
        {{ t("setting.local.directory_default") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { isElectron, isMygo } from "@/utils/env";
import { createLocalDirectorySession } from "@/platform/localDirectorySession";
import { createLibraryDirectoryRecovery } from "@/platform/libraryDirectoryRecovery";
import { filesSession } from "@/platform/filesSession";
import { useSettingStore } from "@/stores";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import { changeLocalPath } from "@/utils/helper";
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
const suggestion = computed(() => directory?.suggestion.value ?? "");
const ready = computed(() => directory?.ready.value ?? false);
const busy = computed(() => directory?.busy.value ?? false);
const grants = computed(() => directory?.grants.value ?? []);
const choose = () => directory?.choose();
const showDefault = () => directory?.showDefault();
const revoke = async (token: string) => {
  const path = grants.value.find((grant) => grant.token === token)?.displayPath;
  await directory?.revoke(token);
  if (path && !grants.value.some((grant) => grant.token === token)) {
    settingStore.localFilesPath = settingStore.localFilesPath.filter((item) => item !== path);
  }
};
const forgetSaved = async (path: string) => {
  const result = await filesSession.value?.forgetSavedDirectory(path);
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
  :deep(.n-list-item__main) {
    .n-thing-main__description {
      font-size: 13px;
      opacity: 0.6;
    }
  }
  .empty {
    padding: 20px 0;
  }
}
</style>
