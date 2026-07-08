<template>
  <div class="create-playlist">
    <n-form ref="onlineFormRef" :model="onlineFormData" :rules="onlineFormRules">
      <n-form-item :label="t('modal.playlist_name')" path="name">
        <n-input
          v-model:value="onlineFormData.name"
          :placeholder="t('modal.playlist_name_placeholder')"
        />
      </n-form-item>
      <n-form-item :label="t('modal.playlist_cover_url')" path="cover">
        <n-input
          v-model:value="onlineFormData.cover"
          :placeholder="t('modal.playlist_cover_url_placeholder')"
        />
      </n-form-item>
      <n-form-item :label="t('modal.playlist_description')" path="description">
        <n-input
          v-model:value="onlineFormData.description"
          :autosize="{
            minRows: 3,
            maxRows: 6,
          }"
          :maxlength="800"
          :placeholder="t('modal.playlist_description_placeholder')"
          type="textarea"
          show-count
          clearable
        />
      </n-form-item>
    </n-form>
    <n-button class="create" type="primary" @click="toCreatePlaylist">
      {{ t("modal.create") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { useFormRule } from "@/utils/rules";
import { debounce } from "lodash-es";
import { isLogin, updateUserCreatedPlaylist } from "@/utils/auth";
import { createUserPlaylist } from "@/api/userplaylist";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const { textRule } = useFormRule();
const emit = defineEmits<{ close: [] }>();

// 表单类型
interface OnlineFormType {
  name: string;
  cover?: string;
  description?: string;
}

// 歌单类别
const playlistType = ref<"online" | "local">(isLogin() ? "online" : "local");

// 在线歌单数据
const onlineFormRef = ref<FormInst | null>(null);
const onlineFormData = ref<OnlineFormType>({ name: "", cover: "", description: "" });
const onlineFormRules: FormRules = { name: textRule };

// 新建歌单
const toCreatePlaylist = debounce(
  async (e: MouseEvent) => {
    e.preventDefault();
    if (playlistType.value === "online") {
      // 是否输入
      await onlineFormRef.value?.validate((errors) => errors);
      // 新建歌单
      createUserPlaylist(
        onlineFormData.value.name || "",
        onlineFormData.value.cover || "",
        onlineFormData.value.description || "",
      ).then(() => {
        emit("close");
        window.$message.success(t("message.create_playlist_success"));
        updateUserCreatedPlaylist();
      });
    }
  },
  300,
  { leading: true, trailing: false },
);
</script>

<style lang="scss" scoped>
.create-playlist {
  .n-form {
    margin-top: 12px;
  }
  .create {
    width: 100%;
  }
  .n-empty {
    padding: 40px 0;
  }
}
</style>
