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
      <n-form-item
        :label="t(local ? 'local_playlists.cover' : 'modal.playlist_cover_url')"
        path="cover"
      >
        <LocalPlaylistCoverPicker
          v-if="local"
          v-model="updateFormData.cover"
          :disabled="saving"
          @loading="coverLoading = $event"
        />
        <n-input
          v-else
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
    <n-button
      class="create"
      type="primary"
      :loading="saving"
      :disabled="local && coverLoading"
      @click="toUpdatePlaylist"
    >
      {{ t("common.edit") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import type { FormInst, FormRules } from "naive-ui";
import { useFormRule } from "@/utils/rules";
import { onScopeDispose } from "vue";
import { useLocalPlaylistStore } from "@/stores/localPlaylists";
import type { LocalPlaylist } from "@/utils/localPlaylist";
import { updateUserCreatedPlaylist } from "@/utils/auth";
import type { UserPlaylistInfo } from "@/types/main.hemusic";
import { updateUserPlaylist } from "@/api/userplaylist";
import { useI18n } from "vue-i18n";
import LocalPlaylistCoverPicker from "@/components/Local/LocalPlaylistCoverPicker.vue";
const { t } = useI18n();
const { textRule } = useFormRule();
// 表单类型
interface UpdateFormType {
  name: string;
  description: string;
  cover: string;
}

const props = defineProps<{
  id: string;
  data: UserPlaylistInfo | LocalPlaylist;
  local?: boolean;
}>();

const emit = defineEmits<{ success: [] }>();

// 是否为我喜欢
const isLiked = !props.local && "is_default" in props.data && props.data.is_default === 1;

// 表单数据
const updateFormRef = ref<FormInst | null>(null);
const updateFormData = ref<UpdateFormType>({
  name: isLiked ? t("playlist.my_favorite_music") : props.data.name,
  description: props.data.description ?? "",
  cover: props.data.cover ?? "",
});
const updateFormRules: FormRules = { name: textRule };

// 更新歌单
const saving = ref(false);
const coverLoading = ref(false);
const localPlaylists = useLocalPlaylistStore();
let active = true;
onScopeDispose(() => {
  active = false;
});
const toUpdatePlaylist = async () => {
  if (saving.value || (props.local && coverLoading.value)) return;
  saving.value = true;
  try {
    const valid = await updateFormRef.value?.validate().then(
      () => true,
      () => false,
    );
    if (!valid || !active) return;
    const details = {
      name: updateFormData.value.name,
      cover: updateFormData.value.cover ?? "",
      description: updateFormData.value.description ?? "",
    };
    if (props.local) {
      await localPlaylists.update(props.id, details);
    } else {
      await updateUserPlaylist(props.id, details.name, details.cover, details.description);
      await updateUserCreatedPlaylist();
    }
    if (!active) return;
    emit("success");
    window.$message.success(t("message.playlist_edit_success"));
  } catch {
    if (active) window.$message.error(t("local_playlists.save_failed"));
  } finally {
    saving.value = false;
  }
};
</script>

<style lang="scss" scoped>
.update-playlist {
  .create {
    width: 100%;
  }
}
</style>
