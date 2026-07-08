<template>
  <div class="local-music-directory">
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
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import SvgIcon from "@/components/Global/SvgIcon.vue";
import { changeLocalPath } from "@/utils/helper";
import { useI18n } from "vue-i18n";
const { t } = useI18n();

const settingStore = useSettingStore();
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
