<template>
  <Provider>
    <router-view />
  </Provider>
</template>

<script setup lang="ts">
import { useDataStore } from "@/stores";
import { useI18n } from "vue-i18n";
import blob from "@/utils/blob";
import { exchangeAuthResult } from "@/api/auth";
const { t } = useI18n();
const dataStore = useDataStore();

onMounted(async () => {
  const params = new URLSearchParams(location.search);
  const state = params.get("state");
  if (state) {
    try {
      const result = await exchangeAuthResult(state);
      dataStore.userLoginStatus = true;
      dataStore.token = result.access_token;
      dataStore.refreshToken = result.refresh_token;
      dataStore.expiresAt = result.expires_at;
      window.$message.success(t("modal.login_success"));
    } catch (error) {
      console.error("OAuth 授权兑换失败：", error);
      window.$message.error(t("modal.login_failed"));
    }
    location.replace("/");
    return;
  }
});
onUnmounted(() => {
  blob.revokeAllBlobURLs();
});
</script>
