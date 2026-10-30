<template>
  <div class="download-song">
    <n-alert v-if="session.persistenceError.value" type="error" :show-icon="false">
      {{ t(session.persistenceError.value) }}
    </n-alert>
    <n-alert type="warning" :title="t('modal.please_know')" closable class="download-warning">
      {{ t("modal.song_download_warning") }}
    </n-alert>
    <SongDataCard :data="song" />
    <n-collapse :default-expanded-names="['level', 'path']" arrow-placement="right">
      <n-collapse-item :title="t('common.song_quality')" name="level">
        <n-radio-group
          v-model:value="quality"
          data-download-field="quality"
          name="level"
          :disabled="busy"
        >
          <n-flex>
            <n-radio v-for="link in supported" :key="link.name" :value="link.name">
              <n-flex>
                <n-text class="name">{{ qualityDescription(link.name) }}</n-text>
                <n-text v-if="Number(link.size) > 0" depth="3">
                  {{ formatFileSize(Number(link.size)) }}
                </n-text>
              </n-flex>
            </n-radio>
          </n-flex>
        </n-radio-group>
      </n-collapse-item>
      <n-collapse-item :title="t('modal.download_path')" name="path">
        <n-input-group>
          <n-select
            v-model:value="directory"
            data-download-field="directory"
            :options="directoryOptions"
            :placeholder="t('modal.download_path_not_configured')"
            :disabled="busy"
          />
          <n-button type="primary" strong secondary :disabled="busy" @click="choose">
            <template #icon><SvgIcon name="Folder" /></template>
            {{ t("local_download.choose_directory") }}
          </n-button>
        </n-input-group>
      </n-collapse-item>
      <n-collapse-item :title="t('local_download.filename')" name="filename">
        <n-input v-model:value="filename" data-download-field="filename" :disabled="busy" />
      </n-collapse-item>
      <n-collapse-item v-if="tasks.length" :title="t('download.download_manager')" name="tasks">
        <div v-for="task in tasks" :key="task.id" class="download-task">
          <n-text>{{ task.label }} — {{ task.filename }}</n-text>
          <n-text depth="3" role="status">{{ t(`local_download.phase_${task.phase}`) }}</n-text>
          <n-alert v-if="task.warning" type="warning" :show-icon="false">
            {{ t(`local_download.warning.${task.warning}`) }}
          </n-alert>
          <n-text v-if="task.residualName" depth="3">
            {{ t("local_download.residual_file") }}：{{ task.residualName }}
          </n-text>
          <n-text depth="3">
            {{ task.received }} / {{ task.total || t("local_download.unknown_size") }}
            {{ t("local_download.bytes")
            }}<span v-if="task.percent !== undefined"> ({{ task.percent }}%)</span>
          </n-text>
          <n-text v-if="task.committed && task.phase !== 'success'">
            {{ t("local_download.possibly_saved") }}
          </n-text>
          <n-text v-if="task.refresh !== 'none'">{{
            t(`local_download.refresh_${task.refresh}`)
          }}</n-text>
          <n-flex justify="end">
            <n-button v-if="!task.done" strong secondary @click="session.cancel(task.id)">
              {{ t("local_download.cancel") }}
            </n-button>
            <n-button
              v-if="task.phase === 'unknown'"
              strong
              secondary
              @click="session.refresh(task.id)"
            >
              {{ t("local_download.refresh") }}
            </n-button>
            <n-button
              v-if="task.retryable"
              strong
              secondary
              :disabled="busy"
              @click="retry = task.id"
            >
              {{ t("local_download.retry") }}
            </n-button>
          </n-flex>
        </div>
      </n-collapse-item>
    </n-collapse>
    <n-alert v-if="failure" type="error" :show-icon="false" class="feedback" role="alert">
      {{ t(`local_download.${failure}`) }}
    </n-alert>
    <n-alert v-if="retry" type="info" :show-icon="false" class="feedback">
      <p>{{ t("local_download.retry_notice") }}</p>
      <p v-if="retryTask">
        {{ retryTask.label }} — {{ retryTask.filename }} — {{ retryTask.quality }}
      </p>
      <n-flex justify="end">
        <n-button :disabled="busy || !retryTask?.retryable" @click="confirmRetry">
          {{ t("local_download.confirm_retry") }}
        </n-button>
        <n-button @click="retry = ''">{{ t("local_download.back") }}</n-button>
      </n-flex>
    </n-alert>
    <n-flex class="menu" justify="end">
      <n-button strong secondary @click="emit('close')">{{ t("common.cancel") }}</n-button>
      <n-button :loading="busy" type="primary" :disabled="busy || !canStart" @click="submit()">
        {{ t("download.add") }}
      </n-button>
    </n-flex>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { useSettingStore, usePlatformStore } from "@/stores";
import { formatFileSize } from "@/utils/helper";
import {
  createLocalDownloadPlan,
  defaultGrantIndex,
  normalizePortableFilename,
} from "@/platform/localDownloadOptions";
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
const settingStore = useSettingStore();
const platformStore = usePlatformStore();
const qualityDescription = (name: string) => {
  const description = platformStore.getPlatformQualityDescription(props.song.platform, name);
  return description ? `${name}(${description})` : name;
};
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
const directoryOptions = computed(() =>
  props.grants.map((grant, index) => ({ label: grant.displayPath, value: index })),
);
const selectDefaultDirectory = () => {
  const index = defaultGrantIndex(props.grants, settingStore.downloadPath);
  directory.value = props.grants.length ? index : 0;
};
const tasks = computed(() => props.session.tasks.value);
const retryTask = computed(() => tasks.value.find((task) => task.id === retry.value));
const songSource = computed(() => localDownloadSource(props.song));
const selected = computed(() => supported.value.find((link) => link.name === quality.value));
const plan = computed(() => createLocalDownloadPlan(props.song, settingStore));
const canStart = computed(
  () =>
    !!props.grants[directory.value] && !!selected.value && validDownloadFilename(filename.value),
);
watch(() => [props.grants, settingStore.downloadPath], selectDefaultDirectory, {
  immediate: true,
  deep: true,
});
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
    filename.value = normalizePortableFilename(
      plan.value.filenameStem,
      link?.format.toLowerCase() ?? "mp3",
    );
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
    settingStore.downloadPath,
    plan.value,
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
  const capturedPlan = plan.value;
  const label = source.name;
  const version = revision;
  busy.value = true;
  failure.value = "";
  try {
    const result = await resolveURL(
      link.name,
      source,
      capturedPlan.options,
      capturedPlan.resolveOptions,
    );
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
      options: result.metadata
        ? { ...capturedPlan.options, metadata: result.metadata }
        : capturedPlan.options,
      resolveOptions: capturedPlan.resolveOptions,
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

<style lang="scss" scoped>
.download-song {
  .download-warning {
    margin-bottom: 20px;
  }
  .n-collapse {
    margin-top: 20px;
  }
  .menu,
  .feedback {
    margin-top: 20px;
  }
  .download-task {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 0;
    overflow-wrap: anywhere;
    & + .download-task {
      border-top: 1px solid rgba(var(--primary), 0.12);
    }
  }
}
</style>
