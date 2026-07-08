<template>
  <n-result
    status="500"
    :title="t('route.server_internal_error')"
    :description="t('route.server_internal_error_tip')"
  >
    <template #footer>
      <n-button type="primary" @click="router.go(0)">
        {{ t("status.reload") }}
      </n-button>
    </template>
  </n-result>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const router = useRouter();
</script>
