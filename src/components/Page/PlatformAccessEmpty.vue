<template>
  <n-empty
    :description="
      t(platformStore.loginRequired ? 'message.login_required' : 'page_section.no_platform')
    "
    size="large"
  >
    <template v-if="platformStore.loginRequired" #extra>
      <n-button type="primary" @click="openUserLogin()">{{ t("common.login") }}</n-button>
    </template>
  </n-empty>
</template>

<script setup lang="ts">
import { usePlatformStore } from "@/stores/platform";
import { openUserLogin } from "@/utils/modal";
import { useI18n } from "vue-i18n";

const platformStore = usePlatformStore();
const { t } = useI18n();
</script>
