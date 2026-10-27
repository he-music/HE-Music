<template>
  <Provider>
    <router-view />
  </Provider>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import blob from "@/utils/blob";
import { exchangeAuthResult } from "@/api/auth";
import { completeLogin, finishWebOAuth } from "@/utils/login";
import { platform } from "@/platform";
const { t } = useI18n();
onMounted(async () => {
  if (platform.kind !== "web") return;
  await finishWebOAuth({
    url: location.href,
    clearQuery: (url) => history.replaceState(history.state, "", url),
    exchange: exchangeAuthResult,
    accept: completeLogin,
    success: () => window.$message.success(t("modal.login_success")),
    failure: () => window.$message.error(t("modal.login_failed")),
    replace: (url) => location.replace(url),
  });
});
onUnmounted(() => {
  blob.revokeAllBlobURLs();
});
</script>
