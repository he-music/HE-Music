<template>
  <div class="update-playlist">
    <n-form ref="updateFormRef" :model="updateFormData" :rules="updateFormRules">
      <n-form-item :label="t('modal.playlist_name')" path="name">
        <n-input
          v-model:value="updateFormData.name"
          :disabled="isLiked"
          :placeholder="t('modal.playlist_name_placeholder')"
        />
      </n-form-item>
      <n-form-item :label="t('modal.playlist_cover_url')" path="cover">
        <n-input
          v-model:value="updateFormData.cover"
          :placeholder="t('modal.playlist_cover_url_placeholder')"
        />
      </n-form-item>
      <n-form-item :label="t('modal.playlist_description')" path="description">
        <n-input
          v-model:value="updateFormData.description"
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
    <n-button class="create" type="primary" @click="toUpdatePlaylist">
      {{ t("common.edit") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { useFormRule } from "@/utils/rules";
import { debounce } from "lodash-es";
import { updateUserCreatedPlaylist } from "@/utils/auth";
import type { UserPlaylistInfo } from "@/types/main.hemusic";
import { updateUserPlaylist } from "@/api/userplaylist";
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const { textRule } = useFormRule();
// 表单类型
interface UpdateFormType {
  name: string;
  description?: string;
  cover?: string;
}

const props = defineProps<{
  id: string;
  data: UserPlaylistInfo;
}>();

const emit = defineEmits<{ success: [] }>();

// 是否为我喜欢
const isLiked = props.data.is_default === 1;

// 表单数据
const updateFormRef = ref<FormInst | null>(null);
const updateFormData = ref<UpdateFormType>({
  name: isLiked ? t("playlist.my_favorite_music") : props.data.name,
  description: props.data.description,
  cover: props.data.cover,
});
const updateFormRules: FormRules = { name: textRule };

// 更新歌单
const toUpdatePlaylist = debounce(
  async (e: MouseEvent) => {
    e.preventDefault();
    // 是否输入
    await updateFormRef.value?.validate((errors) => errors);
    // 新建歌单
    await updateUserPlaylist(
      props.id,
      updateFormData.value.name,
      updateFormData.value.cover ?? "",
      updateFormData.value.description ?? "",
    );
    emit("success");
    window.$message.success(t("message.playlist_edit_success"));
    await updateUserCreatedPlaylist();
  },
  300,
  { leading: true, trailing: false },
);
</script>

<style lang="scss" scoped>
.update-playlist {
  .create {
    width: 100%;
  }
}
</style>
