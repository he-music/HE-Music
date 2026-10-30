<template>
  <form class="song-info-editor" @submit.prevent="save">
    <n-alert v-if="error" type="error" :show-icon="false" role="alert" class="feedback">{{
      error
    }}</n-alert>
    <n-alert v-if="message" type="info" :show-icon="false" role="status" class="feedback">{{
      message
    }}</n-alert>
    <n-alert v-if="otherOperationPath" type="warning" :show-icon="false" class="feedback">
      {{ t("local_metadata.other_pending") }}: {{ otherOperationPath }}
    </n-alert>
    <n-alert v-if="recoveryNames.length" type="warning" :show-icon="false" class="feedback">
      {{ t("local_metadata.recovery_files") }}: {{ recoveryNames.join(", ") }}
    </n-alert>
    <n-tabs type="segment" animated>
      <n-tab-pane name="info" :tab="t('common.info')" display-directive="show">
        <n-flex class="match" justify="space-between" align="center">
          <n-text>{{ t("modal.auto_match_tag_tip") }}</n-text>
          <n-button
            type="primary"
            strong
            secondary
            :loading="matching"
            :disabled="busy || matching || !!session.operation || !loaded || !baselineMD5"
            @click="onlineMatch"
          >
            <template #icon><SvgIcon name="AutoFix" /></template>
            {{ t("modal.auto_match_tag") }}
          </n-button>
        </n-flex>
        <n-list v-if="matchOptions.length" bordered class="match-results">
          <n-list-item v-for="option in matchOptions" :key="option.id">
            <n-button text :disabled="busy || matching" @click="chooseMatch(option.id)">
              {{ option.title }} — {{ option.artists.join(" / ") }} — {{ option.album }}
            </n-button>
          </n-list-item>
        </n-list>
        <n-flex v-if="matching || matchOptions.length" justify="end" class="match-cancel">
          <n-text depth="3">{{ t("local_metadata.match_choose") }}</n-text>
          <n-button size="small" strong secondary @click="cancelMatch">{{
            t("local_metadata.match_cancel")
          }}</n-button>
        </n-flex>
        <n-scrollbar class="scrollbar">
          <n-form :model="form" :disabled="busy || matching" class="phone-form">
            <n-form-item :label="t('local_metadata.title')" path="title">
              <n-input
                v-model:value="form.title"
                :placeholder="t('modal.song_name_placeholder')"
                clearable
              />
            </n-form-item>
            <n-form-item :label="t('local_metadata.artists')" path="artists">
              <n-dynamic-tags
                v-model:value="form.artists"
                :placeholder="t('modal.artist_placeholder')"
              />
            </n-form-item>
            <n-form-item :label="t('local_metadata.album')" path="album">
              <n-input
                v-model:value="form.album"
                :placeholder="t('modal.album_placeholder')"
                clearable
              />
            </n-form-item>
            <n-form-item :label="t('local_metadata.album_artists')" path="albumArtists">
              <n-dynamic-tags
                v-model:value="form.albumArtists"
                :placeholder="t('modal.artist_placeholder')"
              />
            </n-form-item>
            <n-form-item :label="t('local_metadata.comment')" path="comment">
              <n-input v-model:value="form.comment" clearable />
            </n-form-item>
            <n-form-item :label="t('local_metadata.lyrics')" path="lyrics">
              <n-input
                v-model:value="form.lyrics"
                :autosize="{ minRows: 3, maxRows: 6 }"
                :placeholder="t('modal.lyrics_placeholder')"
                type="textarea"
              />
            </n-form-item>
            <n-grid :cols="24" :x-gap="24">
              <n-form-item-gi :span="24" :label="t('common.filename')">
                <n-input :value="entry.filename" disabled />
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.type')">
                <n-input :value="baseline?.Codec || baseline?.Container || ''" disabled />
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.bitrate')">
                <n-input-number :value="baseline?.BitrateKbps" :show-button="false" disabled>
                  <template #suffix><n-text depth="3">kbps</n-text></template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.duration')">
                <n-input-number :value="baseline?.DurationSeconds" :show-button="false" disabled>
                  <template #suffix><n-text depth="3">s</n-text></template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.sample_rate')">
                <n-input-number :value="baseline?.SampleRateHz" :show-button="false" disabled>
                  <template #suffix><n-text depth="3">Hz</n-text></template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.path')">
                <n-input :value="entry.relativePath" disabled />
              </n-form-item-gi>
              <n-form-item-gi :span="12" :label="t('common.bits_per_sample')">
                <n-input-number :value="baseline?.BitsPerSample" :show-button="false" disabled>
                  <template #suffix><n-text depth="3">bit</n-text></template>
                </n-input-number>
              </n-form-item-gi>
              <n-form-item-gi :span="24" label="MD5">
                <n-input :value="baselineMD5" disabled />
              </n-form-item-gi>
            </n-grid>
          </n-form>
        </n-scrollbar>
      </n-tab-pane>
      <n-tab-pane name="cover" :tab="t('common.cover')" display-directive="show">
        <label class="cover" :class="{ disabled: busy || matching }">
          <img :src="coverPreview || '/images/song.jpg?asset'" :alt="t('local_metadata.cover')" />
          <input
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            :disabled="busy || matching"
            @change="selectCover"
          />
        </label>
        <n-flex class="cover-menu" justify="center" align="center">
          <n-text depth="3">{{ t("modal.click_to_change_cover") }}</n-text>
          <n-button text :disabled="busy || matching" @click="clearCover">{{
            t("local_metadata.clear_cover")
          }}</n-button>
        </n-flex>
      </n-tab-pane>
    </n-tabs>
    <n-flex class="menu" justify="center">
      <n-button class="btn" strong secondary @click="closeEditor">{{
        t("common.cancel")
      }}</n-button>
      <n-button
        v-if="session.operation"
        class="btn"
        strong
        secondary
        :disabled="busy || matching || !operationId"
        @click="reconcile"
      >
        {{ t("local_metadata.reconcile") }}
      </n-button>
      <n-button
        class="btn"
        type="primary"
        attr-type="submit"
        :loading="busy"
        :disabled="busy || matching || !loaded"
      >
        {{ t("common.save") }}
      </n-button>
    </n-flex>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  Info,
  LocalMetadataSession,
  MetadataSessionResult,
} from "@/platform/localMetadataSession";
import type { LocalFileRef, Patch, Picture, ScanEntry } from "@/platform/mygo.bindings";
import { useSettingStore } from "@/stores";
import { LocalMetadataMatch, type MetadataMatchCandidate } from "@/platform/localMetadataMatch";
import { createMetadataMatchAPI } from "@/platform/localMetadataMatchAPI";

const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const MAX_PICTURE_TOTAL = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const { t } = useI18n();
const props = defineProps<{ entry: ScanEntry; session: LocalMetadataSession }>();
const emit = defineEmits<{ close: [] }>();
const settingStore = useSettingStore();
const baselineMD5 = ref("");
const matching = ref(false);
const matchOptions = ref<MetadataMatchCandidate[]>([]);
let matchScope: LocalMetadataMatch | undefined;

const loaded = ref(false);
const mounted = ref(false);
const busy = ref(false);
const error = ref("");
const message = ref("");
const recoveryNames = ref<string[]>([]);
const baseline = ref<Info>();
const baselineSha256 = ref("");
const coverMode = ref<"preserve" | "clear" | "replace">("preserve");
const pictures = ref<Picture[]>([]);
const coverPreview = ref("");
const viewGeneration = ref(0);
const fileGeneration = ref(0);
let finalResultPresented = false;
const form = reactive({
  title: "",
  artists: [] as string[],
  album: "",
  albumArtists: [] as string[],
  comment: "",
  lyrics: "",
});

const refKey = (entry: ScanEntry) => JSON.stringify(entry.ref);
function sameTarget(left: LocalFileRef, right: LocalFileRef): boolean {
  return left.grantToken === right.grantToken && left.relativePath === right.relativePath;
}
const operationId = computed(() => {
  const operation = props.session.operation;
  return operation && sameTarget(operation.ref, props.entry.ref) ? operation.operationId : "";
});
const otherOperationPath = computed(() => {
  const operation = props.session.operation;
  return operation && !sameTarget(operation.ref, props.entry.ref) ? operation.ref.relativePath : "";
});

function applyInfo(info: Info, sha256: string | undefined): void {
  baseline.value = info;
  baselineSha256.value = sha256 ?? "";
  form.title = info.Title;
  form.artists = [...info.Artists];
  form.album = info.Album;
  form.albumArtists = [...info.AlbumArtists];
  form.comment = info.Comment;
  form.lyrics = info.Lyrics;
  pictures.value = info.Pictures.map((picture) => ({ ...picture }));
  const first = pictures.value[0];
  coverPreview.value =
    first && ALLOWED_MIME.has(first.MIME) ? `data:${first.MIME};base64,${first.Data}` : "";
  coverMode.value = "preserve";
}

function cancelMatch(): void {
  matchScope?.cancel();
  matchScope = undefined;
  matching.value = false;
  matchOptions.value = [];
}

function closeEditor(): void {
  cancelMatch();
  emit("close");
}

async function onlineMatch(): Promise<void> {
  if (
    busy.value ||
    matching.value ||
    props.session.operation ||
    !loaded.value ||
    !baseline.value ||
    !baselineMD5.value
  )
    return;
  cancelMatch();
  const owner = props.session;
  const openedEntry = props.entry;
  const expected = refKey(props.entry);
  const generation = viewGeneration.value;
  const capturedRef = { ...props.entry.ref };
  const scope = new LocalMetadataMatch(
    createMetadataMatchAPI(() => settingStore),
    () =>
      mounted.value &&
      props.session === owner &&
      props.entry === openedEntry &&
      generation === viewGeneration.value &&
      expected === refKey(props.entry) &&
      !owner.operation &&
      owner.ownsReference(capturedRef),
  );
  matchScope = scope;
  matching.value = true;
  error.value = "";
  try {
    const options = await scope.search(
      { ...baseline.value, Title: form.title, Artists: [...form.artists], Album: form.album },
      baselineMD5.value,
    );
    if (matchScope !== scope || !scope.isCurrent()) return;
    matchOptions.value = options ?? [];
    if (options && !options.length) error.value = t("message.match_fail");
  } catch {
    if (matchScope === scope && scope.isCurrent()) error.value = t("message.match_fail");
  } finally {
    if (matchScope === scope) matching.value = false;
  }
}

async function chooseMatch(id: number): Promise<void> {
  const scope = matchScope;
  if (!scope || busy.value || matching.value) return;
  matching.value = true;
  error.value = "";
  try {
    const draft = await scope.choose(id);
    if (!draft || matchScope !== scope || !scope.isCurrent()) return;
    form.title = draft.title;
    form.artists = [...draft.artists];
    form.album = draft.album;
    form.comment = draft.comment;
    form.lyrics = draft.lyrics;
    if (draft.picture) {
      fileGeneration.value++;
      pictures.value = [{ ...draft.picture }];
      coverPreview.value = `data:${draft.picture.MIME};base64,${draft.picture.Data}`;
      coverMode.value = "replace";
    }
    matchOptions.value = [];
    message.value = t("local_metadata.match_review");
  } catch {
    if (matchScope === scope && scope.isCurrent()) error.value = t("message.match_fail");
  } finally {
    if (matchScope === scope) matching.value = false;
  }
}

async function load(): Promise<void> {
  cancelMatch();
  baselineMD5.value = "";
  const generation = ++viewGeneration.value;
  finalResultPresented = false;
  fileGeneration.value++;
  busy.value = false;
  message.value = "";
  recoveryNames.value = [];
  const expected = refKey(props.entry);
  const owner = props.session;
  loaded.value = false;
  try {
    const result = await owner.read({ ...props.entry.ref });
    if (
      !mounted.value ||
      props.session !== owner ||
      generation !== viewGeneration.value ||
      expected !== refKey(props.entry)
    )
      return;
    if (!result?.info || !result.sha256) {
      error.value = t("local_metadata.read_failed");
      return;
    }
    applyInfo(result.info, result.sha256);
    baselineMD5.value = result.md5 ?? "";
    error.value = result.code === "read_ref_conflict" ? t("local_metadata.ref_conflict") : "";
    loaded.value = true;
  } catch {
    if (mounted.value && generation === viewGeneration.value)
      error.value = t("local_metadata.read_failed");
  }
}

function clearCover(): void {
  fileGeneration.value++;
  coverMode.value = "clear";
  pictures.value = [];
  coverPreview.value = "";
}

function selectCover(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const generation = ++fileGeneration.value;
  if (
    !ALLOWED_MIME.has(file.type) ||
    file.size > MAX_PICTURE_BYTES ||
    file.size > MAX_PICTURE_TOTAL
  ) {
    error.value = t("local_metadata.invalid_cover");
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    if (!mounted.value || generation !== fileGeneration.value || typeof reader.result !== "string")
      return;
    const comma = reader.result.indexOf(",");
    const data = comma >= 0 ? reader.result.slice(comma + 1) : "";
    if (!data) return;
    pictures.value = [{ MIME: file.type, Type: 0, Description: "", Data: data }];
    coverPreview.value = reader.result;
    coverMode.value = "replace";
  };
  reader.onerror = () => {
    if (mounted.value && generation === fileGeneration.value)
      error.value = t("local_metadata.invalid_cover");
  };
  try {
    reader.readAsDataURL(file);
  } catch {
    error.value = t("local_metadata.invalid_cover");
  }
  input.value = "";
}

function changed<T>(value: T, original: T): boolean {
  return JSON.stringify(value) !== JSON.stringify(original);
}

function snapshotPatch(original: Info): Patch {
  return {
    Title: changed(form.title, original.Title) ? form.title : null,
    Artists: changed(form.artists, original.Artists) ? [...form.artists] : null,
    Album: changed(form.album, original.Album) ? form.album : null,
    AlbumArtists: changed(form.albumArtists, original.AlbumArtists) ? [...form.albumArtists] : null,
    Comment: changed(form.comment, original.Comment) ? form.comment : null,
    Lyrics: changed(form.lyrics, original.Lyrics) ? form.lyrics : null,
    Pictures:
      coverMode.value === "preserve" ? null : pictures.value.map((picture) => ({ ...picture })),
  };
}

function presentResult(result: MetadataSessionResult, final = false): void {
  if (finalResultPresented && !final) return;
  finalResultPresented ||= final;
  error.value = "";
  message.value = "";
  if (result.committed) {
    cancelMatch();
    baselineMD5.value = "";
    viewGeneration.value++;
    fileGeneration.value++;
    busy.value = false;
    loaded.value = false;
    baselineSha256.value = "";
    recoveryNames.value = [result.recoveryName, ...(result.residualNames ?? [])].filter(
      (name): name is string =>
        Boolean(name) &&
        !name?.startsWith("/") &&
        !name?.includes("\\") &&
        !name?.split("/").includes("..") &&
        !name?.includes(":"),
    );
    if (result.refresh === "failed") message.value = t("local_metadata.saved_refresh_failed");
    else if (result.code === "ok" && result.ref) message.value = t("local_metadata.saved");
    else message.value = t("local_metadata.committed_needs_review");
    if (result.recoveryName || result.residualNames?.length || !result.ref)
      message.value += ` ${t("local_metadata.recovery_hint")}`;
    return;
  }
  error.value = props.session.operation
    ? t("local_metadata.pending")
    : t("local_metadata.save_failed");
}

async function reconcile(): Promise<void> {
  const expected = refKey(props.entry);
  const generation = viewGeneration.value;
  const operation = props.session.operation;
  if (!operation || !sameTarget(operation.ref, props.entry.ref)) return;
  const sourceRef = { ...operation.ref };
  const id = operation.operationId;
  busy.value = true;
  try {
    const result = await props.session.reconcile(id);
    if (
      result &&
      mounted.value &&
      generation === viewGeneration.value &&
      expected === refKey(props.entry) &&
      sameTarget(sourceRef, props.entry.ref)
    )
      presentResult(result);
  } catch {
    if (mounted.value) error.value = t("local_metadata.pending");
  } finally {
    if (mounted.value && generation === viewGeneration.value) busy.value = false;
  }
}

async function save(): Promise<void> {
  const original = baseline.value;
  if (busy.value || matching.value || !loaded.value || !original || !baselineSha256.value) return;
  const expected = refKey(props.entry);
  const generation = viewGeneration.value;
  const sha256 = baselineSha256.value;
  const patch = snapshotPatch(original);
  const capturedRef = { ...props.entry.ref };
  try {
    if (!window.confirm(t("local_metadata.confirm_save"))) return;
    if (
      !mounted.value ||
      expected !== refKey(props.entry) ||
      sha256 !== baselineSha256.value ||
      JSON.stringify(patch) !== JSON.stringify(snapshotPatch(original))
    ) {
      error.value = t("local_metadata.confirm_changed");
      return;
    }
  } catch {
    error.value = t("local_metadata.save_failed");
    return;
  }
  finalResultPresented = false;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await props.session.save(capturedRef, sha256, patch);
    if (mounted.value && generation === viewGeneration.value && expected === refKey(props.entry))
      presentResult(result);
  } catch {
    if (mounted.value) error.value = t("local_metadata.save_failed");
  } finally {
    if (mounted.value && generation === viewGeneration.value) busy.value = false;
  }
}

watch(() => [props.session, props.entry, refKey(props.entry)], load, { flush: "sync" });
watch(
  () => [props.session.operation, viewGeneration.value] as const,
  ([operation, generation]) => {
    if (!operation || !sameTarget(operation.ref, props.entry.ref)) return;
    const owner = props.session;
    const expected = refKey(props.entry);
    finalResultPresented = false;
    void operation.completion.then((result) => {
      if (
        mounted.value &&
        props.session === owner &&
        generation === viewGeneration.value &&
        expected === refKey(props.entry) &&
        sameTarget(operation.ref, props.entry.ref)
      )
        presentResult(result, true);
    });
  },
  { immediate: true },
);
onMounted(() => {
  mounted.value = true;
  void load();
});
onUnmounted(() => {
  cancelMatch();
  mounted.value = false;
  viewGeneration.value++;
  fileGeneration.value++;
});
</script>

<style lang="scss" scoped>
.song-info-editor {
  :deep(.scrollbar) {
    max-height: 60vh;
  }
  .match {
    margin-bottom: 12px;
    border: 1px solid rgba(var(--primary), 0.26);
    border-radius: 8px;
    padding: 12px 16px;
    background-color: rgba(var(--primary), 0.08);
  }
  .match-results {
    max-height: 180px;
    overflow: auto;
    margin-bottom: 12px;
  }
  .match-cancel,
  .feedback {
    margin-bottom: 12px;
  }
  .cover {
    position: relative;
    display: flex;
    width: 300px;
    height: 300px;
    max-width: 100%;
    justify-content: center;
    border-radius: 16px;
    margin: 20px auto 0;
    overflow: hidden;
    cursor: pointer;
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
    }
    &.disabled {
      cursor: default;
    }
  }
  .cover-menu {
    margin-top: 20px;
  }
  .menu {
    width: 100%;
    margin-top: 20px;
  }
  :deep(.n-input-number) {
    width: 100%;
  }
}
</style>
