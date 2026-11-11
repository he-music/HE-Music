<template>
  <div class="create-playlist">
    <n-tabs v-if="canCreateLocal" v-model:value="playlistType" type="segment" class="playlist-type">
      <n-tab name="online" :disabled="saving || !!songs?.length">
        {{ t("local_playlists.online") }}
      </n-tab>
      <n-tab name="local" :disabled="saving">{{ t("local_playlists.title") }}</n-tab>
    </n-tabs>
    <n-form ref="formRef" :model="form" :rules="rules">
      <n-form-item :label="t('modal.playlist_name')" path="name">
        <n-input
          v-model:value="form.name"
          :maxlength="100"
          :placeholder="t('modal.playlist_name_placeholder')"
        />
      </n-form-item>
      <n-form-item
        :label="t(playlistType === 'local' ? 'local_playlists.cover' : 'modal.playlist_cover_url')"
        path="cover"
      >
        <LocalPlaylistCoverPicker
          v-if="playlistType === 'local'"
          v-model="localCover"
          :disabled="saving"
          @loading="coverLoading = $event"
        />
        <n-input
          v-else
          v-model:value="form.cover"
          :placeholder="t('modal.playlist_cover_url_placeholder')"
        />
      </n-form-item>
      <n-form-item :label="t('modal.playlist_description')" path="description">
        <n-input
          v-model:value="form.description"
          :autosize="{ minRows: 3, maxRows: 6 }"
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
      :disabled="playlistType === 'local' && coverLoading"
      @click="create"
    >
      {{ t("modal.create") }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import { onScopeDispose, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import type { FormInst, FormRules } from "naive-ui";
import { useFormRule } from "@/utils/rules";
import { isLogin, updateUserCreatedPlaylist } from "@/utils/auth";
import { openUserLogin } from "@/utils/modal";
import { useLocalPlaylistStore } from "@/stores/localPlaylists";
import { useSettingStore } from "@/stores/setting";
import { platform } from "@/platform";
import type { SongInfo } from "@/types/main.hemusic";
import { createUserPlaylist } from "@/api/userplaylist";
import LocalPlaylistCoverPicker from "@/components/Local/LocalPlaylistCoverPicker.vue";

const props = defineProps<{ local?: boolean; songs?: SongInfo[] }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const { textRule } = useFormRule();
const router = useRouter();
const setting = useSettingStore();
const playlists = useLocalPlaylistStore();
const canCreateLocal = platform.kind === "mygo" && platform.capabilities.localMusic;
const playlistType = ref<"online" | "local">(
  canCreateLocal && (props.local || !isLogin() || !setting.useOnlineService) ? "local" : "online",
);
const saving = ref(false);
const coverLoading = ref(false);
const localCover = ref("");
const formRef = ref<FormInst | null>(null);
const form = ref({ name: "", cover: "", description: "" });
const rules: FormRules = { name: textRule };
let active = true;
onScopeDispose(() => {
  active = false;
});

async function create() {
  if (saving.value || (playlistType.value === "local" && coverLoading.value)) return;
  if (playlistType.value === "online" && !isLogin()) {
    void openUserLogin();
    return;
  }
  saving.value = true;
  try {
    const valid = await formRef.value?.validate().then(
      () => true,
      () => false,
    );
    if (!valid || !active) return;
    let localID: string | undefined;
    if (playlistType.value === "local") {
      localID = await playlists.create(form.value.name, props.songs, {
        ...form.value,
        cover: localCover.value,
      });
    } else {
      await createUserPlaylist(form.value.name, form.value.cover, form.value.description);
      await updateUserCreatedPlaylist();
    }
    if (!active) return;
    window.$message.success(t("message.create_playlist_success"));
    emit("close");
    if (localID) void router.push({ name: "local-playlist", query: { id: localID } });
  } catch {
    if (active) window.$message.error(t("local_playlists.save_failed"));
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.create-playlist {
  .playlist-type {
    margin-bottom: 24px;
  }
  .create {
    width: 100%;
  }
}
</style>
