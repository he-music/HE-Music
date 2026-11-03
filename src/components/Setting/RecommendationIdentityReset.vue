<template>
  <n-button
    type="warning"
    secondary
    strong
    :loading="loading"
    :disabled="loading"
    @click="confirmReset"
  >
    {{ t("recommendation_identity.label") }}
  </n-button>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import type { DialogReactive } from "naive-ui";
import { useI18n } from "vue-i18n";
import { resetProviderIdentity } from "@/api/providerIdentity";
import { useDataStore } from "@/stores";
import {
  createRecommendationIdentityReset,
  type RecommendationOwner,
} from "@/composables/recommendationIdentityReset";

const { t } = useI18n();
const dataStore = useDataStore();
const accountEpoch = ref(0);
watch(
  () => [dataStore.userLoginStatus, dataStore.userData.id],
  () => {
    accountEpoch.value += 1;
  },
  { flush: "sync" },
);
const currentOwner = computed<RecommendationOwner | undefined>(() =>
  dataStore.userLoginStatus && dataStore.userData.id
    ? { accountId: dataStore.userData.id, epoch: accountEpoch.value }
    : undefined,
);
const action = createRecommendationIdentityReset({
  reset: resetProviderIdentity,
  currentOwner: () => currentOwner.value,
  showSuccess: () => window.$message.success(t("recommendation_identity.success")),
  showUnknownResult: () => window.$message.error(t("recommendation_identity.unknown_result")),
});
const { loading } = action;
let dialog: DialogReactive | undefined;
const confirmReset = () => {
  const owner = currentOwner.value;
  if (loading.value || dialog || !owner) return;
  const confirmation = window.$dialog.warning({
    title: t("recommendation_identity.confirm_title"),
    content: t("recommendation_identity.confirm_content"),
    positiveText: t("recommendation_identity.confirm"),
    negativeText: t("common.cancel"),
    closable: false,
    maskClosable: false,
    closeOnEsc: false,
    positiveButtonProps: {
      get loading() {
        return loading.value;
      },
      get disabled() {
        return loading.value;
      },
    },
    negativeButtonProps: {
      get disabled() {
        return loading.value;
      },
    },
    onPositiveClick: async () => {
      await action.reset(owner);
    },
    onAfterLeave: () => {
      if (dialog === confirmation) dialog = undefined;
    },
  });
  dialog = confirmation;
};
watch(
  () => currentOwner.value,
  () => {
    dialog?.destroy();
    dialog = undefined;
  },
  { flush: "sync" },
);
onScopeDispose(() => dialog?.destroy());
</script>
