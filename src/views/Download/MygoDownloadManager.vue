<template>
  <section class="download mygo-downloads" :aria-label="t('download.download_manager')">
    <div class="title">
      <n-text class="keyword">{{ t("download.download_manager") }}</n-text>
      <n-flex class="counts">
        <n-text class="item"
          ><SvgIcon name="Download" :depth="3" />{{ visibleTasks.length }}</n-text
        >
        <n-text class="item" depth="3">
          {{ currentTab === "completed" ? unfinishedCount : completedCount }}
          {{ currentTab === "completed" ? t("download.downloading") : t("common.completed") }}
        </n-text>
      </n-flex>
    </div>
    <n-flex class="menu" justify="space-between">
      <n-flex class="left" align="flex-end">
        <n-button
          :focusable="false"
          :disabled="currentTab !== 'completed' || !songs.length"
          type="primary"
          strong
          secondary
          round
          @click="playDownloaded"
        >
          <template #icon><SvgIcon name="Play" /></template>{{ t("common.play") }}
        </n-button>
      </n-flex>
      <n-tabs v-model:value="currentTab" class="tabs" type="segment">
        <n-tab name="completed">{{ t("common.completed") }}</n-tab>
        <n-tab name="downloading">{{ t("download.downloading") }}</n-tab>
      </n-tabs>
    </n-flex>
    <n-text v-if="filesSession?.downloads?.persistenceError?.value" role="alert" type="error">{{
      t(filesSession.downloads.persistenceError.value)
    }}</n-text>
    <LocalScanIssues />
    <n-empty
      v-if="!filesSession?.downloads"
      :description="t('mygo.downloads.unavailable')"
      class="empty"
      role="status"
    />
    <div v-else-if="visibleTasks.length" class="download-list">
      <div class="list-header">
        <n-text class="num">#</n-text><n-text class="task-title">{{ t("common.title") }}</n-text>
        <n-text class="status">{{ t("common.status") }}</n-text
        ><n-text class="actions">{{ t("common.operation") }}</n-text>
      </div>
      <n-scrollbar class="virtual-list">
        <div
          v-for="(task, index) in visibleTasks"
          :key="task.id"
          :data-task-id="task.id"
          class="download-item"
          @contextmenu.prevent="openMenu($event, task.id)"
          @dblclick="playTask(task.id)"
        >
          <div class="num">
            <n-text depth="3">{{ index + 1 }}</n-text>
          </div>
          <div class="task-title">
            <DownloadedArtwork
              :song="files.get(task.id)"
              :fallback="task.display?.cover"
              class="cover"
            />
            <div class="info">
              <n-text class="name-text" ellipsis :title="task.label">{{ task.label }}</n-text>
              <n-text class="artists text-hidden" depth="3">{{
                task.display?.artists || ""
              }}</n-text>
              <n-text class="artists text-hidden" depth="3">{{ task.quality }}</n-text>
            </div>
          </div>
          <div class="status">
            <n-flex vertical :size="6">
              <n-flex justify="space-between">
                <n-text :type="task.phase === 'failed' ? 'error' : undefined" role="status">{{
                  taskStatus(task)
                }}</n-text>
                <n-text v-if="!task.done" depth="3"
                  >{{ bytes(task.received) }} /
                  {{ task.total > 0 ? bytes(task.total) : "—" }}</n-text
                >
              </n-flex>
              <n-progress
                v-if="!task.done"
                type="line"
                :color="task.phase === 'active' ? 'rgb(var(--primary))' : undefined"
                :percentage="task.percent ?? 0"
                :show-indicator="false"
                class="downloading-progress"
                style="height: 4px"
                :aria-label="t('mygo.downloads.progress')"
              />
              <n-text v-if="task.done && task.committed && !files.has(task.id)" depth="3">{{
                t(
                  task.refresh === "pending"
                    ? "mygo.downloads.readingFile"
                    : "mygo.downloads.fileUnavailable",
                )
              }}</n-text>
              <n-text v-if="task.interrupted" depth="3">{{
                t("mygo.downloads.interrupted")
              }}</n-text>
              <n-text
                v-if="task.warning && task.warning !== 'cancelled'"
                type="warning"
                role="status"
                >{{ t(`local_download.warning.${task.warning}`) }}</n-text
              >
              <n-text v-if="task.residualName" depth="3"
                >{{ t("local_download.residual_file") }}：{{ task.residualName }}</n-text
              >
              <n-text v-if="errors.has(task.id)" type="error" role="alert">{{
                t("mygo.downloads.actionFailed")
              }}</n-text>
            </n-flex>
          </div>
          <n-flex class="actions" align="center" justify="center" :aria-busy="busy(task.id)">
            <n-button
              v-if="task.done && task.committed"
              :disabled="busy(task.id) || !files.has(task.id)"
              :aria-label="t('common.play')"
              type="primary"
              secondary
              strong
              @click="playTask(task.id)"
              ><template #icon><SvgIcon name="Play" /></template
            ></n-button>
            <n-button
              v-else-if="task.retryable"
              :disabled="busy(task.id)"
              :aria-label="t('mygo.downloads.retry')"
              type="primary"
              secondary
              strong
              @click="run(task.id, 'retry')"
              ><template #icon><SvgIcon name="Refresh" /></template
            ></n-button>
            <n-button
              :disabled="busy(task.id)"
              :aria-label="t('mygo.downloads.remove')"
              type="error"
              secondary
              strong
              @click="run(task.id, 'remove')"
              ><template #icon><SvgIcon name="Close" /></template
            ></n-button>
          </n-flex>
        </div>
      </n-scrollbar>
    </div>
    <n-empty v-else :description="t('common.list_empty')" class="empty" role="status" />
    <n-dropdown
      trigger="manual"
      :show="menuOpen && !!menuTask"
      :x="menuX"
      :y="menuY"
      :options="menuOptions"
      @select="selectMenu"
      @clickoutside="menuOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from "vue";
import LocalScanIssues from "@/components/Local/LocalScanIssues.vue";
import DownloadedArtwork from "@/components/Local/DownloadedArtwork.vue";
import type { DropdownOption } from "naive-ui";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { filesSession } from "@/platform/filesSession";
import { useMygoDownloadTasks } from "@/composables/mygoDownloadTasks";
import { useMygoDownloadedSongs } from "@/composables/mygoDownloadedSongs";
import { localFilesSession, nativeLocalEntry } from "@/platform/localFilesSession";
import { LocalFileActions } from "@/platform/localFileActions";
import type { LocalDownloadTask } from "@/platform/localDownloadSession";
import { useMusicStore } from "@/stores";
import { usePlayer } from "@/utils/player";

const { t } = useI18n();
const { tasks, completed, unfinished, pending, errors, run } = useMygoDownloadTasks(filesSession);
const { songs, files } = useMygoDownloadedSongs(filesSession, completed);
const completedCount = computed(() => completed.value.length);
const unfinishedCount = computed(() => unfinished.value.length);
const music = useMusicStore();
const player = usePlayer();
const route = useRoute();
const router = useRouter();
const currentTab = computed<"completed" | "downloading">({
  get: () => (route.name === "download-downloaded" ? "completed" : "downloading"),
  set: (value) => {
    const name = value === "completed" ? "download-downloaded" : "download-downloading";
    if (route.name !== name) void router.push({ name });
  },
});
const visibleTasks = computed(() =>
  currentTab.value === "completed" ? completed.value : unfinished.value,
);
const filePending = shallowRef<ReadonlySet<string>>(new Set());
const busy = (id: string) => pending.value.has(id) || filePending.value.has(id);
const menuOpen = shallowRef(false);
const menuID = shallowRef("");
const menuX = shallowRef(0);
const menuY = shallowRef(0);
let menuOwner = filesSession.value;
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
watch([filesSession, currentTab], ([owner], [previous]) => {
  menuOpen.value = false;
  if (owner !== previous) filePending.value = new Set();
});
const menuTask = computed(() => tasks.value.find((task) => task.id === menuID.value));
const menuOptions = computed<DropdownOption[]>(() => {
  const task = menuTask.value;
  if (!task) return [];
  const song = files.value.get(task.id);
  const isPlaying =
    song && music.playSong.id === song.id && music.playSong.platform === song.platform;
  const options: DropdownOption[] = [];
  if (task.committed) {
    options.push({ key: "play", label: t("common.play"), disabled: busy(task.id) || !song });
    options.push({ key: "reveal", label: t("menu.open_folder"), disabled: busy(task.id) || !song });
    options.push({
      key: "delete-file",
      label: t("menu.delete_file"),
      disabled: busy(task.id) || !song || isPlaying,
    });
  } else if (task.retryable) {
    options.push({ key: "retry", label: t("mygo.downloads.retry"), disabled: busy(task.id) });
  }
  options.push({ key: "remove", label: t("mygo.downloads.remove"), disabled: busy(task.id) });
  return options;
});
function openMenu(event: MouseEvent, id: string): void {
  menuOwner = filesSession.value;
  menuID.value = id;
  menuX.value = event.clientX;
  menuY.value = event.clientY;
  menuOpen.value = true;
}
function selectMenu(key: string): void {
  menuOpen.value = false;
  const task = menuTask.value;
  if (!task || filesSession.value !== menuOwner || busy(task.id)) return;
  if (key === "remove" || key === "retry") void run(task.id, key);
  else if (key === "play") playTask(task.id);
  else if (key === "reveal") void runFileAction(task.id, "reveal");
  else if (key === "delete-file") {
    const owner = menuOwner;
    window.$dialog.warning({
      title: t("common.confirm_delete"),
      content: t("mygo.downloads.deleteFileConfirm", { name: task.label }),
      positiveText: t("common.delete"),
      negativeText: t("common.cancel"),
      onPositiveClick: () => {
        if (filesSession.value === owner && tasks.value.includes(task))
          return runFileAction(task.id, "remove");
        return undefined;
      },
    });
  }
}
function playTask(id: string): void {
  const song = files.value.get(id);
  if (song && !busy(id)) void player.addNextSong(song, true);
}
function playDownloaded(): void {
  if (songs.value.length) void player.updatePlayList(songs.value);
}
async function runFileAction(id: string, action: "reveal" | "remove"): Promise<void> {
  const owner = filesSession.value;
  const local = localFilesSession.value;
  const task = tasks.value.find((task) => task.id === id);
  const song = files.value.get(id);
  const entry = song ? nativeLocalEntry(song.id) : undefined;
  if (!owner || !local || !task || !song || !entry || busy(id)) return;
  const native = owner.fileActionAccess(entry.ref);
  if (!native) return;
  const current = () =>
    !disposed &&
    filesSession.value === owner &&
    localFilesSession.value === local &&
    tasks.value.includes(task) &&
    files.value.get(id) === song &&
    nativeLocalEntry(song.id) === entry &&
    native.current();
  const actions = new LocalFileActions({
    access: () => ({ ...native, current }),
    isPlaying: () => music.playSong.id === song.id && music.playSong.platform === song.platform,
    onRemoved: () => {
      void local.refreshAfterWrite().catch(() => {
        if (!disposed && filesSession.value === owner)
          window.$message.error(t("mygo.downloads.fileRefreshFailed"));
      });
    },
  });
  filePending.value = new Set(filePending.value).add(id);
  try {
    if (action === "reveal") {
      if (!(await actions.reveal(song)) && current())
        window.$message.error(t("message.local_file_action_failed"));
    } else {
      const result = await actions.remove(song);
      if (result.removed && result.current) window.$message.success(t("menu.delete_file_success"));
      else if (current()) window.$message.error(t("message.local_file_action_failed"));
    }
  } finally {
    if (!disposed && filesSession.value === owner)
      filePending.value = new Set([...filePending.value].filter((value) => value !== id));
  }
}
function taskStatus(task: LocalDownloadTask): string {
  if (task.done && task.committed) return t("common.completed");
  if (task.warning === "cancelled") return t("mygo.downloads.cancelled");
  if (task.phase === "active" && task.percent !== undefined) return `${task.percent}%`;
  return t(`mygo.downloads.phase.${task.phase}`);
}
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
</script>

<style scoped lang="scss">
.download {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  .title {
    display: flex;
    align-items: flex-end;
    line-height: normal;
    margin-top: 12px;
    margin-bottom: 20px;
    min-height: 40px;
    .keyword {
      font-size: 30px;
      font-weight: bold;
      margin-right: 12px;
    }
    .counts {
      font-size: 15px;
      line-height: 30px;
      .item {
        display: flex;
        align-items: center;
        gap: 4px;
        opacity: 0.9;
      }
    }
  }
  .menu {
    width: 100%;
    margin-bottom: 20px;
    .more {
      width: 40px;
    }
    .n-button {
      height: 40px;
    }
    .tabs {
      width: 200px;
      --n-tab-border-radius: 25px !important;
      :deep(.n-tabs-rail) {
        outline: 1px solid var(--n-tab-color-segment);
      }
    }
  }
  .download-list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    .list-header,
    .download-item {
      display: flex;
      align-items: center;
      padding: 0 12px;
      .num {
        width: 60px;
        min-width: 60px;
        text-align: center;
      }
      .task-title,
      .status {
        flex: 1;
        min-width: 0;
        padding-left: 12px;
        padding-right: 20px;
      }
      .actions {
        width: 120px;
        min-width: 120px;
        text-align: center;
      }
    }
    .list-header {
      min-height: 40px;
      background-color: var(--background-hex);
      .n-text {
        opacity: 0.6;
      }
    }
    .virtual-list {
      flex: 1;
      min-height: 0;
    }
    .download-item {
      padding: 12px;
      border-radius: 12px;
      border: 2px solid rgba(var(--primary), 0.12);
      background-color: var(--surface-container-hex);
      margin-bottom: 12px;
      transition: border-color 0.3s;
      &:hover {
        border-color: rgba(var(--primary), 0.58);
      }
      .task-title {
        display: flex;
        align-items: center;
        overflow: hidden;
        .cover {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 50px;
          min-width: 50px;
          height: 50px;
          border-radius: 8px;
          margin-right: 12px;
          overflow: hidden;
        }
        .info {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1;
          .name-text {
            font-size: 16px;
            margin-bottom: 4px;
          }
          .artists {
            font-size: 12px;
          }
        }
      }
      .status {
        font-size: 12px;
        .downloading-progress {
          --n-fill-color: rgb(var(--primary));
        }
      }
      .actions .n-button {
        border-radius: 8px;
      }
    }
  }
  .download-downloaded {
    flex: 1;
    min-height: 0;
  }
  .empty {
    margin-top: 60px;
  }
}
</style>
