<template>
  <div class="download-song">
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
          <n-input
            :value="settingStore.downloadPath || t('modal.download_path_not_configured')"
            data-download-field="directory"
            :disabled="true"
          >
            <template #prefix><SvgIcon name="Folder" /></template>
          </n-input>
          <n-button type="primary" strong secondary :disabled="busy" @click="configure">
            <template #icon><SvgIcon name="Settings" /></template>
            {{ t("setting.local.download_config") }}
          </n-button>
        </n-input-group>
      </n-collapse-item>
    </n-collapse>
    <n-alert v-if="failure" type="error" :show-icon="false" class="feedback" role="alert">
      {{ t(`local_download.${failure}`) }}
    </n-alert>
    <n-flex class="menu" justify="end">
      <n-button strong secondary @click="close">{{ t("common.cancel") }}</n-button>
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
import { openSetting } from "@/utils/modal";
import {
  createLocalDownloadPlan,
  defaultGrantIndex,
  normalizePortableFilename,
} from "@/platform/localDownloadOptions";
import { validLocalDownloadFormat } from "@/platform/localDownloadPersistence";
import { audioOutputFormat } from "@/platform/audioSource";
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
const directory = computed(() => defaultGrantIndex(props.grants, settingStore.downloadPath));
const quality = ref("");
const busy = ref(false);
const failure = ref("");
let closed = false;
let revision = 0;
onScopeDispose(() => {
  closed = true;
  revision++;
});
const supported = computed(() =>
  props.song.links.filter((link) =>
    validLocalDownloadFormat(audioOutputFormat(props.song.platform, link.format)),
  ),
);
const songSource = computed(() => localDownloadSource(props.song));
const selected = computed(() => supported.value.find((link) => link.name === quality.value));
const plan = computed(() => createLocalDownloadPlan(props.song, settingStore));
const filename = computed(() =>
  normalizePortableFilename(
    plan.value.filenameStem,
    audioOutputFormat(props.song.platform, selected.value?.format ?? "mp3"),
  ),
);
const canStart = computed(
  () =>
    !!props.grants[directory.value] && !!selected.value && validDownloadFilename(filename.value),
);
watch(
  () => props.song,
  () => {
    revision++;
    quality.value =
      supported.value.find((link) => link.name === "320mp3")?.name ??
      supported.value.at(-1)?.name ??
      "";
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
function configure(): void {
  if (!closed && !busy.value) openSetting("local");
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
  const song = props.song;
  const display = {
    artists: Array.isArray(song.artists)
      ? song.artists.map((artist) => artist.name).join(" / ")
      : song.artists || "",
    album: typeof song.album === "string" ? song.album : song.album.name,
    cover: song.cover,
    duration: song.duration,
  };
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
      display,
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
    if (!closed && revision === version && props.session === session) {
      window.$message?.success(t("message.download_added"));
      close();
    }
  } catch {
    if (!closed && revision === version && props.session === session)
      failure.value = "operation_failed";
  } finally {
    busy.value = false;
  }
}
function close(): void {
  closed = true;
  revision++;
  emit("close");
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
}
</style>
