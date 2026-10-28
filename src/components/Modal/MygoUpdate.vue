<template>
  <div class="mygo-update">
    <n-text role="status">{{ t(`updates.phase_${phase}`) }}</n-text>
    <n-text v-if="state?.version" class="version">{{
      t("updates.version", { version: state.version })
    }}</n-text>
    <p v-if="state?.notes" class="notes">{{ state.notes }}</p>
    <n-alert v-if="phase === 'available' || phase === 'installing'" type="info" :show-icon="false">
      {{ t("updates.apply_notice") }}
    </n-alert>
    <n-alert v-if="failure" type="warning" :show-icon="false">{{ failure }}</n-alert>
    <n-flex justify="end">
      <n-button :disabled="!current || busy" @click="run('check')">
        {{ t("setting.about.check_update") }}
      </n-button>
      <n-button :disabled="!current || acting" @click="run('refresh')">
        {{ t("updates.refresh") }}
      </n-button>
      <n-button
        v-if="phase === 'available'"
        type="primary"
        :disabled="!current || busy"
        @click="confirmInstall"
      >
        {{ t("updates.apply") }}
      </n-button>
      <n-button v-if="owner" @click="emit('close')">{{ t("common.close") }}</n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref } from "vue";
import { useI18n } from "vue-i18n";
import { UpdatesSession, updatesSession } from "@/platform/updatesSession";

const props = defineProps<{ owner?: UpdatesSession }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const session = computed(() => props.owner ?? updatesSession.value);
const current = computed(() => {
  const value = session.value;
  return value?.ready.value === true && updatesSession.value === value;
});
const state = computed(() => (current.value ? session.value?.state.value : undefined));
const phase = computed(() => state.value?.phase ?? "unavailable");
const acting = ref(false);
const confirming = ref(false);
const failure = ref("");
const busy = computed(() => acting.value || confirming.value || session.value?.busy.value === true);
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});

async function run(operation: "check" | "refresh" | "install") {
  const value = session.value;
  if (disposed || !current.value || !value || acting.value) return;
  failure.value = "";
  acting.value = true;
  try {
    await value[operation]();
  } catch {
    if (!disposed && current.value) failure.value = t("updates.operation_failed");
  } finally {
    acting.value = false;
  }
}

function confirmInstall() {
  if (disposed || !current.value || busy.value || phase.value !== "available") return;
  const candidate = state.value;
  if (!candidate) return;
  confirming.value = true;
  const release = () => {
    confirming.value = false;
  };
  window.$dialog.warning({
    title: t("updates.apply"),
    content: `${t("updates.version", { version: candidate.version })}\n\n${t("updates.apply_notice")}`,
    positiveText: t("updates.apply"),
    negativeText: t("common.cancel"),
    onNegativeClick: release,
    onClose: release,
    onAfterLeave: release,
    onPositiveClick: async () => {
      release();
      if (
        state.value?.phase !== "available" ||
        state.value.operationRevision !== candidate.operationRevision ||
        state.value.version !== candidate.version
      ) {
        if (!disposed && current.value) failure.value = t("updates.candidate_changed");
        return;
      }
      await run("install");
    },
  });
}
</script>

<style scoped lang="scss">
.mygo-update {
  display: flex;
  flex-direction: column;
  gap: 16px;
  .notes {
    max-height: 300px;
    margin: 0;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}
</style>
