<template>
  <section class="download mygo-downloads" :aria-label="t('download.download_manager')">
    <div class="title">
      <n-text class="keyword">{{ t("download.download_manager") }}</n-text>
      <n-flex class="counts">
        <n-text class="item">
          <SvgIcon name="Download" :depth="3" />
          {{ currentTab === "completed" ? songs.length : activeCount }}
        </n-text>
        <n-text class="item" depth="3">
          <SvgIcon :name="currentTab === 'completed' ? 'Download' : 'DownloadDone'" :depth="3" />
          {{ currentTab === "completed" ? activeCount : completedCount }}
          {{ currentTab === "completed" ? t("download.downloading") : t("common.completed") }}
        </n-text>
      </n-flex>
    </div>
    <n-flex class="menu" justify="space-between">
      <n-flex class="left" align="flex-end">
        <n-button
          :focusable="false"
          :disabled="removable.length === 0"
          type="primary"
          strong
          secondary
          round
          @click="clearDone"
        >
          <template #icon><SvgIcon name="Delete" /></template>
          {{ t("mygo.downloads.clearDone") }}
        </n-button>
      </n-flex>
      <n-flex class="right" justify="end">
        <n-tabs v-model:value="currentTab" class="tabs" type="segment">
          <n-tab name="completed">{{ t("common.completed") }}</n-tab>
          <n-tab name="downloading">{{ t("download.downloading") }}</n-tab>
        </n-tabs>
      </n-flex>
    </n-flex>
    <n-text v-if="filesSession?.downloads?.persistenceError?.value" role="alert" type="error">
      {{ t(filesSession.downloads.persistenceError.value) }}
    </n-text>
    <n-empty
      v-if="!filesSession?.downloads"
      :description="t('mygo.downloads.unavailable')"
      class="empty"
      role="status"
    />
    <div v-else-if="currentTab === 'completed'" class="download-downloaded">
      <n-text v-if="needsScan" class="scan-recovery" role="status">{{
        t("local.scan_empty")
      }}</n-text>
      <div v-for="task in completedNotices" :key="task.id" class="completed-notice" role="status">
        <n-text>{{ task.label }}</n-text>
        <n-text v-if="task.warning" type="warning">{{
          t(`local_download.warning.${task.warning}`)
        }}</n-text>
        <n-text v-if="task.residualName" depth="3"
          >{{ t("local_download.residual_file") }}：{{ task.residualName }}</n-text
        >
        <n-text v-if="task.refresh === 'pending'">{{ t("mygo.downloads.scanning") }}</n-text>
        <n-text v-else-if="task.refresh === 'failed'">{{ t("mygo.downloads.scanFailed") }}</n-text>
        <n-text v-if="errors.has(task.id)" type="error" role="alert">{{
          t("mygo.downloads.actionFailed")
        }}</n-text>
        <n-button
          :disabled="pending.has(task.id) || task.refresh === 'pending'"
          :aria-label="t('mygo.downloads.remove')"
          @click="run(task.id, 'retire')"
        >
          <template #icon><SvgIcon name="Close" /></template>
        </n-button>
      </div>
      <SongList :data="songs" :loading="false" />
    </div>
    <div v-else-if="visibleTasks.length" class="download-list">
      <div class="list-header">
        <n-text class="num">#</n-text>
        <n-text class="task-title">{{ t("common.title") }}</n-text>
        <n-text class="status">{{ t("common.status") }}</n-text>
        <n-text class="actions">{{ t("common.operation") }}</n-text>
      </div>
      <n-scrollbar class="virtual-list">
        <div v-for="(task, index) in visibleTasks" :key="task.id" class="download-item">
          <div class="num">
            <n-text depth="3">{{ index + 1 }}</n-text>
          </div>
          <div class="task-title">
            <s-image :src="task.display?.cover || '/images/song.jpg?asset'" class="cover" />
            <div class="info">
              <n-text class="name-text" ellipsis :title="task.label">{{ task.label }}</n-text>
              <n-text class="artists text-hidden" depth="3">{{
                task.display?.artists || ""
              }}</n-text>
            </div>
          </div>
          <div class="status">
            <n-flex vertical :size="6">
              <n-flex justify="space-between">
                <n-text
                  :type="task.phase === 'failed' ? 'error' : undefined"
                  :depth="task.phase === 'failed' ? undefined : '3'"
                  role="status"
                >
                  {{
                    task.phase === "active" && task.percent !== undefined
                      ? `${task.percent}%`
                      : t(`mygo.downloads.phase.${task.phase}`)
                  }}
                </n-text>
                <n-text v-if="task.phase === 'active'" depth="3">
                  {{ bytes(task.received) }} / {{ task.total > 0 ? bytes(task.total) : "—" }}
                </n-text>
              </n-flex>
              <n-progress
                type="line"
                :color="task.phase === 'active' ? 'rgb(var(--primary))' : undefined"
                :percentage="task.percent ?? 0"
                :show-indicator="false"
                :status="task.phase === 'failed' ? 'error' : undefined"
                class="downloading-progress"
                style="height: 4px"
                :aria-label="t('mygo.downloads.progress')"
              />
              <n-text v-if="task.interrupted" depth="3">{{
                t("mygo.downloads.interrupted")
              }}</n-text>
              <n-text v-if="task.warning" type="warning" role="status">
                {{ t(`local_download.warning.${task.warning}`) }}
              </n-text>
              <n-text v-if="task.residualName" depth="3">
                {{ t("local_download.residual_file") }}：{{ task.residualName }}
              </n-text>
              <n-text v-if="task.refresh === 'pending'">{{ t("mygo.downloads.scanning") }}</n-text>
              <n-text v-else-if="task.refresh === 'failed'" role="status">
                {{ t("mygo.downloads.scanFailed") }}
              </n-text>
              <n-text v-if="errors.has(task.id)" type="error" role="alert">
                {{ t("mygo.downloads.actionFailed") }}
              </n-text>
            </n-flex>
          </div>
          <n-flex class="actions" align="center" justify="center" :aria-busy="pending.has(task.id)">
            <template v-if="!task.done">
              <n-button
                :disabled="pending.has(task.id)"
                :aria-label="t('mygo.downloads.refresh')"
                :title="t('mygo.downloads.refresh')"
                type="primary"
                secondary
                strong
                @click="run(task.id, 'refresh')"
              >
                <template #icon><SvgIcon name="Refresh" /></template>
              </n-button>
              <n-button
                :disabled="pending.has(task.id)"
                :aria-label="t('mygo.downloads.cancel')"
                :title="t('mygo.downloads.cancel')"
                type="error"
                secondary
                strong
                @click="run(task.id, 'cancel')"
              >
                <template #icon><SvgIcon name="Close" /></template>
              </n-button>
            </template>
            <n-button
              v-if="task.retryable && !task.committed"
              :disabled="pending.has(task.id)"
              :aria-label="t('mygo.downloads.retry')"
              :title="t('mygo.downloads.retry')"
              type="primary"
              secondary
              strong
              @click="run(task.id, 'retry')"
            >
              <template #icon><SvgIcon name="Refresh" /></template>
            </n-button>
            <n-button
              v-if="task.done"
              :disabled="pending.has(task.id) || task.refresh === 'pending'"
              :aria-label="t('mygo.downloads.remove')"
              :title="t('mygo.downloads.remove')"
              type="error"
              secondary
              strong
              @click="run(task.id, 'retire')"
            >
              <template #icon><SvgIcon name="Close" /></template>
            </n-button>
          </n-flex>
        </div>
      </n-scrollbar>
    </div>
    <n-empty v-else :description="t('mygo.downloads.empty')" class="empty" role="status" />
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import SongList from "@/components/List/SongList.vue";
import { useMygoDownloadedSongs } from "@/composables/mygoDownloadedSongs";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { filesSession } from "@/platform/filesSession";
import { useMygoDownloadTasks } from "@/composables/mygoDownloadTasks";

const { t } = useI18n();
const { tasks, pending, errors, removable, run, clearDone } = useMygoDownloadTasks(filesSession);
const route = useRoute();
const router = useRouter();
const currentTab = computed<"completed" | "downloading">({
  get: () => (route.name === "download-downloaded" ? "completed" : "downloading"),
  set: (value) => {
    const name = value === "completed" ? "download-downloaded" : "download-downloading";
    if (route.name !== name) void router.push({ name });
  },
});
const { songs, unmatched } = useMygoDownloadedSongs(filesSession, tasks);
const completedTasks = computed(() => tasks.value.filter((task) => task.committed));
const activeTasks = computed(() => {
  const priority = { active: 0, unknown: 1, failed: 2, saved: 2, success: 2 };
  return tasks.value
    .filter((task) => !task.committed)
    .sort((a, b) => priority[a.phase] - priority[b.phase]);
});
const needsScan = computed(() =>
  unmatched.value.some((task) => task.refresh !== "pending" && task.refresh !== "failed"),
);
const completedNotices = computed(() =>
  completedTasks.value.filter(
    (task) =>
      task.warning ||
      task.residualName ||
      task.refresh === "pending" ||
      task.refresh === "failed" ||
      errors.value.has(task.id),
  ),
);
const completedCount = computed(() => songs.value.length);
const activeCount = computed(() => activeTasks.value.length);
const visibleTasks = activeTasks;
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
  .completed-notice {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 12px;
  }
  .empty {
    margin-top: 60px;
  }
}
</style>
