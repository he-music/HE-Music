<template>
  <n-result status="404" :title="t('route.not_found')" :description="t('route.not_found_tip')">
    <template #footer>
      <n-button type="primary" @click="router.go(-1)">
        {{ t("route.back") }}
      </n-button>
    </template>
  </n-result>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const router = useRouter();
</script>
