<template>
  <form class="mygo-song-info-editor" @submit.prevent="save">
    <p class="path">{{ entry.relativePath }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="otherOperationPath">
      {{ t("local_metadata.other_pending") }}: {{ otherOperationPath }}
    </p>
    <p v-if="recoveryNames.length">
      {{ t("local_metadata.recovery_files") }}: {{ recoveryNames.join(", ") }}
    </p>
    <fieldset :disabled="busy">
      <label>{{ t("local_metadata.title") }}<input v-model="form.title" /></label>
      <label>{{ t("local_metadata.artists") }}<input v-model="artistsText" /></label>
      <label>{{ t("local_metadata.album") }}<input v-model="form.album" /></label>
      <label>{{ t("local_metadata.album_artists") }}<input v-model="albumArtistsText" /></label>
      <label>{{ t("local_metadata.comment") }}<input v-model="form.comment" /></label>
      <label>{{ t("local_metadata.lyrics") }}<textarea v-model="form.lyrics" rows="6" /></label>
      <section class="pictures">
        <span>{{ t("local_metadata.cover") }}</span>
        <img v-if="coverPreview" :src="coverPreview" :alt="t('local_metadata.cover')" />
        <button type="button" @click="clearCover">{{ t("local_metadata.clear_cover") }}</button>
        <input
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          @change="selectCover"
        />
      </section>
    </fieldset>
    <p>{{ t("local_metadata.save_warning") }}</p>
    <button type="button" @click="emit('close')">{{ t("common.cancel") }}</button>
    <button type="button" :disabled="busy || !operationId" @click="reconcile">
      {{ t("local_metadata.reconcile") }}
    </button>
    <button type="submit" :disabled="busy || !loaded">{{ t("common.save") }}</button>
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

const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const MAX_PICTURE_TOTAL = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const { t } = useI18n();
const props = defineProps<{ entry: ScanEntry; session: LocalMetadataSession }>();
const emit = defineEmits<{ close: [] }>();

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

const artistsText = computed({
  get: () => form.artists.join(", "),
  set: (value: string) =>
    (form.artists = value
      .split(",")
      .map((artist) => artist.trim())
      .filter(Boolean)),
});
const albumArtistsText = computed({
  get: () => form.albumArtists.join(", "),
  set: (value: string) =>
    (form.albumArtists = value
      .split(",")
      .map((artist) => artist.trim())
      .filter(Boolean)),
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

async function load(): Promise<void> {
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
    if (!mounted.value || generation !== viewGeneration.value || expected !== refKey(props.entry))
      return;
    if (!result?.info || !result.sha256) {
      error.value = t("local_metadata.read_failed");
      return;
    }
    applyInfo(result.info, result.sha256);
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
  if (!loaded.value || !original || !baselineSha256.value) return;
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

watch(() => [props.session, refKey(props.entry)], load);
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
  mounted.value = false;
  viewGeneration.value++;
  fileGeneration.value++;
});
</script>

<style scoped>
.mygo-song-info-editor {
  display: grid;
  gap: 12px;
}
.mygo-song-info-editor label {
  display: grid;
  gap: 4px;
}
.mygo-song-info-editor input,
.mygo-song-info-editor textarea {
  width: 100%;
  box-sizing: border-box;
}
.path {
  word-break: break-all;
}
.pictures img {
  display: block;
  max-width: 240px;
  max-height: 240px;
}
</style>
