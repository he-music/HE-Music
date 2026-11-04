<template>
  <div class="update-app">
    <n-flex :size="10" class="version" align="center">
      <n-tag :bordered="false" type="primary">{{ packageJson.version }}</n-tag>
      <SvgIcon name="Right" />
      <n-tag :bordered="false" type="warning">{{ state?.version || "—" }}</n-tag>
    </n-flex>
    <n-scrollbar style="max-height: 500px">
      <div
        v-if="renderedNotes"
        v-dompurify-html="renderedNotes"
        class="markdown-body"
        @click="jumpLink"
      />
      <div v-else class="markdown-body">{{ t("modal.no_update_log") }}</div>
    </n-scrollbar>
    <n-flex v-if="phase === 'installing'" vertical :size="8">
      <n-progress v-if="downloadPercent !== null" type="line" :percentage="downloadPercent" />
      <n-spin v-else size="small" />
      <n-text>{{
        t(downloadPercent === null ? "updates.download_received" : "updates.download_progress", {
          downloaded: downloadedMB,
          total: totalMB,
        })
      }}</n-text>
    </n-flex>
    <n-text v-if="phase !== 'available' && phase !== 'installing'" role="status">{{
      t(`updates.phase_${phase}`)
    }}</n-text>
    <n-alert v-if="failure" type="warning" :show-icon="false">{{ failure }}</n-alert>
    <n-flex class="menu" justify="end">
      <n-button strong secondary @click="emit('close')">{{
        t(phase === "installed" ? "updates.later" : "common.close")
      }}</n-button>
      <n-button
        v-if="phase === 'installing'"
        :loading="session?.cancelling.value"
        :disabled="!current || !session?.canCancel.value"
        @click="cancelInstall"
        >{{ t(session?.cancelling.value ? "updates.cancelling" : "updates.cancel") }}</n-button
      >
      <n-button v-if="phase === 'cancelled'" :disabled="busy" @click="checkAgain">{{
        t("setting.about.check_update")
      }}</n-button>
      <n-button type="warning" strong secondary :disabled="busy" @click="goDownload">{{
        t("modal.click_download")
      }}</n-button>
      <n-button
        v-if="phase === 'available' || phase === 'installing'"
        type="primary"
        :loading="busy"
        :disabled="!current || busy"
        @click="installUpdate"
        >{{ t(phase === "installing" ? "updates.phase_installing" : "modal.update_now") }}</n-button
      >
      <n-button
        v-if="phase === 'installed'"
        type="primary"
        :loading="restarting"
        :disabled="!current || busy"
        @click="restartApp"
      >
        {{ t("updates.restart") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref } from "vue";
import packageJson from "@/../package.json";
import { useI18n } from "vue-i18n";
import { marked } from "marked";
import { platform } from "@/platform";
import { UpdatesSession, updatesSession } from "@/platform/updatesSession";
import "github-markdown-css/github-markdown.css";
import { filesSession } from "@/platform/filesSession";
import { flushApplicationWrites } from "@/platform/applicationStorage";

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
const restarting = ref(false);
const downloadPercent = computed(() => {
  const value = state.value;
  return value && value.total > 0
    ? Math.min(100, Math.round((value.downloaded / value.total) * 1000) / 10)
    : null;
});
const downloadedMB = computed(() => ((state.value?.downloaded ?? 0) / 1024 / 1024).toFixed(1));
const totalMB = computed(() => ((state.value?.total ?? 0) / 1024 / 1024).toFixed(1));
const failure = ref("");
const busy = computed(
  () => restarting.value || session.value?.busy.value === true || phase.value === "installing",
);
const renderedNotes = computed(() =>
  state.value?.notes ? marked.parse(state.value.notes, { async: false }) : "",
);
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
async function openExternal(url: string): Promise<boolean> {
  try {
    await platform.openExternal(url);
    return true;
  } catch {
    if (!disposed && current.value) failure.value = t("updates.operation_failed");
    return false;
  }
}
async function goDownload(): Promise<void> {
  if (disposed || busy.value) return;
  if (await openExternal(`${packageJson.github}/releases`)) {
    if (!disposed) emit("close");
  }
}
function jumpLink(event: MouseEvent): void {
  const target = event.target;
  const link = target instanceof Element ? target.closest("a") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  if (!disposed && /^https?:\/\//i.test(link.href)) void openExternal(link.href);
}
async function installUpdate(): Promise<void> {
  const owner = session.value;
  if (disposed || !current.value || busy.value || phase.value !== "available" || !owner) return;
  try {
    failure.value = "";
    await owner.install();
  } catch {
    if (!disposed && current.value && session.value === owner)
      failure.value = t("updates.operation_failed");
  }
}
async function cancelInstall(): Promise<void> {
  const owner = session.value;
  if (disposed || !current.value || !owner?.canCancel.value) return;
  try {
    failure.value = "";
    await owner.cancel();
  } catch {
    if (!disposed && current.value && session.value === owner && phase.value === "installing")
      failure.value = t("updates.operation_failed");
  }
}
async function checkAgain(): Promise<void> {
  const owner = session.value;
  if (disposed || !current.value || busy.value || !owner) return;
  try {
    failure.value = "";
    await owner.check();
  } catch {
    if (!disposed && current.value && session.value === owner)
      failure.value = t("updates.operation_failed");
  }
}
async function restartApp(): Promise<void> {
  const owner = session.value;
  if (disposed || !current.value || busy.value || phase.value !== "installed" || !owner) return;
  restarting.value = true;
  try {
    const fileOwner = filesSession.value?.capturePreferencesResetOwner();
    await fileOwner?.dispose();
    await flushApplicationWrites();
    if (
      updatesSession.value !== owner ||
      !owner.ready.value ||
      owner.state.value?.phase !== "installed"
    )
      return;
    await owner.restart();
  } catch {
    if (!disposed) failure.value = t("updates.operation_failed");
  } finally {
    restarting.value = false;
  }
}
</script>

<style scoped lang="scss">
.update-app {
  .version {
    margin-bottom: 20px;
    .n-tag {
      border-radius: 6px;
    }
  }
  .menu {
    margin-top: 20px;
  }
  .markdown-body {
    margin-top: 0 !important;
  }
  .n-alert {
    margin-top: 16px;
  }
}
</style>
