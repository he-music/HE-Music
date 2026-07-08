<template>
  <n-result status="403" :title="t('route.forbidden')" :description="t('route.forbidden_tip')">
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
