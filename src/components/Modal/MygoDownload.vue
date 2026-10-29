<template>
  <div class="mygo-download">
    <p>{{ t("local_download.notice") }}</p>
    <p v-if="session.persistenceError.value" role="alert">
      {{ t(session.persistenceError.value) }}
    </p>
    <label>{{ t("local_download.directory") }}</label>
    <n-select v-model:value="directory" :options="directoryOptions" />
    <n-button :disabled="busy" @click="choose">{{ t("local_download.choose_directory") }}</n-button>
    <label>{{ t("local_download.quality") }}</label>
    <n-select v-model:value="quality" :options="qualityOptions" />
    <label>{{ t("local_download.filename") }}</label>
    <n-input v-model:value="filename" />
    <p v-if="failure" role="alert">{{ t(`local_download.${failure}`) }}</p>
    <n-button :disabled="busy || !canStart" @click="submit()">{{
      t("local_download.start")
    }}</n-button>
    <ul>
      <li v-for="task in tasks" :key="task.id">
        <span>{{ task.label }} — {{ task.filename }}</span>
        <p role="status">{{ t(`local_download.phase_${task.phase}`) }}</p>
        <p>
          {{ task.received }} / {{ task.total || t("local_download.unknown_size") }}
          {{ t("local_download.bytes")
          }}<span v-if="task.percent !== undefined"> ({{ task.percent }}%)</span>
        </p>
        <p v-if="task.committed && task.phase !== 'success'">
          {{ t("local_download.possibly_saved") }}
        </p>
        <p v-if="task.refresh !== 'none'">{{ t(`local_download.refresh_${task.refresh}`) }}</p>
        <n-button v-if="!task.done" @click="session.cancel(task.id)">{{
          t("local_download.cancel")
        }}</n-button>
        <n-button v-if="task.phase === 'unknown'" @click="session.refresh(task.id)">{{
          t("local_download.refresh")
        }}</n-button>
        <n-button v-if="task.retryable" :disabled="busy" @click="retry = task.id">{{
          t("local_download.retry")
        }}</n-button>
      </li>
    </ul>
    <div v-if="retry">
      <p>{{ t("local_download.retry_notice") }}</p>
      <p v-if="retryTask">
        {{ retryTask.label }} — {{ retryTask.filename }} — {{ retryTask.quality }}
      </p>
      <n-button :disabled="busy || !retryTask?.retryable" @click="confirmRetry">{{
        t("local_download.confirm_retry")
      }}</n-button>
      <n-button @click="retry = ''">{{ t("local_download.back") }}</n-button>
    </div>
    <n-button @click="emit('close')">{{ t("local_download.close") }}</n-button>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { validLocalDownloadFormat } from "@/platform/localDownloadPersistence";
import { useI18n } from "vue-i18n";
import type { SongInfo } from "@/types/main.hemusic";
import type { DirectoryGrant } from "@/platform/mygo.bindings";
import {
  LocalDownloadSession,
  validDownloadFilename,
  localDownloadSource,
  type LocalDownloadResolver,
} from "@/platform/localDownloadSession";

const props = defineProps<{
  song: SongInfo;
  session: LocalDownloadSession;
  grants: readonly DirectoryGrant[];
  chooseDirectory: () => Promise<void>;
  resolveURL: LocalDownloadResolver;
}>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const directory = ref(0);
const quality = ref("");
const filename = ref("");
const busy = ref(false);
const failure = ref("");
const retry = ref("");
let closed = false;
let revision = 0;
onScopeDispose(() => {
  closed = true;
  revision++;
});
const supported = computed(() =>
  props.song.links.filter((link) => validLocalDownloadFormat(link.format)),
);
const qualityOptions = computed(() =>
  supported.value.map((link) => ({ label: link.name, value: link.name })),
);
const directoryOptions = computed(() =>
  props.grants.map((grant, index) => ({ label: grant.displayPath, value: index })),
);
const tasks = computed(() => props.session.tasks.value);
const retryTask = computed(() => tasks.value.find((task) => task.id === retry.value));
const songSource = computed(() => localDownloadSource(props.song));
const selected = computed(() => supported.value.find((link) => link.name === quality.value));
const canStart = computed(
  () =>
    !!props.grants[directory.value] && !!selected.value && validDownloadFilename(filename.value),
);
watch(
  () => props.song,
  () => {
    revision++;
    quality.value = supported.value[0]?.name ?? "";
    retry.value = "";
  },
  { immediate: true },
);
watch(
  selected,
  (link) => {
    filename.value = `${
      props.song.name
        .replace(/[\\/:<>"|?*\p{Cc}]/gu, "_")
        .replace(/^\.+/, "_")
        .trim() || "audio"
    }.${link?.format.toLowerCase() ?? "mp3"}`;
  },
  { immediate: true },
);
watch(
  () => [
    quality.value,
    filename.value,
    props.grants[directory.value]?.token,
    props.grants[directory.value]?.epoch,
    props.session,
    props.resolveURL,
    songSource.value,
  ],
  () => {
    revision++;
  },
  { flush: "sync" },
);
async function choose() {
  if (busy.value) return;
  failure.value = "";
  try {
    await props.chooseDirectory();
  } catch {
    if (!closed) failure.value = "operation_failed";
  }
}
async function submit() {
  if (closed || busy.value || !canStart.value) return;
  const session = props.session;
  const grant = props.grants[directory.value];
  const source = songSource.value;
  const link = source.links.find((item) => item.name === quality.value);
  if (!grant || !link) return;
  const name = filename.value;
  const resolveURL = props.resolveURL;
  const label = source.name;
  const version = revision;
  busy.value = true;
  failure.value = "";
  try {
    const result = await resolveURL(link.name, source);
    if (
      closed ||
      revision !== version ||
      props.session !== session ||
      props.resolveURL !== resolveURL ||
      quality.value !== link.name ||
      filename.value !== name ||
      props.grants[directory.value]?.token !== grant.token ||
      props.grants[directory.value]?.epoch !== grant.epoch ||
      !props.grants.some((item) => item.token === grant.token && item.epoch === grant.epoch)
    )
      return;
    const format = result.format.toLowerCase();
    if (
      !validLocalDownloadFormat(format) ||
      format !== link.format.toLowerCase() ||
      !name.toLowerCase().endsWith(`.${format}`)
    )
      throw new Error("Unavailable");
    const id = await session.start({
      grantToken: grant.token,
      filename: name,
      label,
      quality: link.name,
      source,
      resolveURL,
      url: result.url,
    });
    if (!id) {
      if (!closed) failure.value = "start_rejected";
      return;
    }
    retry.value = "";
  } catch {
    if (!closed && revision === version && props.session === session)
      failure.value = "operation_failed";
  } finally {
    busy.value = false;
  }
}
async function confirmRetry() {
  if (closed || busy.value || !retry.value) return;
  const session = props.session;
  const id = retry.value;
  busy.value = true;
  failure.value = "";
  try {
    const next = await session.retry(id);
    if (!closed && props.session === session) {
      if (next) retry.value = "";
      else failure.value = "retry_rejected";
    }
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.mygo-download {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
li {
  overflow-wrap: anywhere;
}
</style>
