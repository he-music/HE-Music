<template>
  <section class="mygo-downloads" :aria-label="t('download.download_manager')">
    <header>
      <h1>{{ t("download.download_manager") }}</h1>
      <button type="button" :disabled="removable.length === 0" @click="clearDone">
        {{ t("mygo.downloads.clearDone") }}
      </button>
    </header>
    <p>{{ t("mygo.downloads.sessionOnly") }}</p>
    <p v-if="filesSession?.downloads?.persistenceError?.value" role="alert">
      {{ t(filesSession.downloads.persistenceError.value) }}
    </p>
    <p v-if="!filesSession?.downloads" role="status">{{ t("mygo.downloads.unavailable") }}</p>
    <p v-else-if="tasks.length === 0" role="status">{{ t("mygo.downloads.empty") }}</p>
    <ul v-else>
      <li v-for="task in tasks" :key="task.id">
        <h2>{{ task.label }}</h2>
        <p class="filename">{{ task.filename }} · {{ task.quality }}</p>
        <p role="status">{{ t(`mygo.downloads.phase.${task.phase}`) }}</p>
        <p v-if="task.interrupted">{{ t("mygo.downloads.interrupted") }}</p>
        <template v-if="!task.done">
          <progress :value="task.percent" max="100" :aria-label="t('mygo.downloads.progress')" />
          <p>{{ bytes(task.received) }} / {{ task.total > 0 ? bytes(task.total) : "—" }}</p>
        </template>
        <p v-if="task.refresh === 'pending'">{{ t("mygo.downloads.scanning") }}</p>
        <p v-else-if="task.refresh === 'failed'" role="status">
          {{ t("mygo.downloads.scanFailed") }}
        </p>
        <p v-if="errors.has(task.id)" role="alert">{{ t("mygo.downloads.actionFailed") }}</p>
        <div class="actions" :aria-busy="pending.has(task.id)">
          <template v-if="!task.done">
            <button type="button" :disabled="pending.has(task.id)" @click="run(task.id, 'refresh')">
              {{ t("mygo.downloads.refresh") }}
            </button>
            <button type="button" :disabled="pending.has(task.id)" @click="run(task.id, 'cancel')">
              {{ t("mygo.downloads.cancel") }}
            </button>
          </template>
          <button
            v-if="task.retryable"
            type="button"
            :disabled="pending.has(task.id)"
            @click="run(task.id, 'retry')"
          >
            {{ t("mygo.downloads.retry") }}
          </button>
          <button
            v-if="task.done"
            type="button"
            :disabled="pending.has(task.id) || task.refresh === 'pending'"
            @click="run(task.id, 'retire')"
          >
            {{ t("mygo.downloads.remove") }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { filesSession } from "@/platform/filesSession";
import { useMygoDownloadTasks } from "@/composables/mygoDownloadTasks";

const { t } = useI18n();
const { tasks, pending, errors, removable, run, clearDone } = useMygoDownloadTasks(filesSession);
function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
</script>

<style scoped lang="scss">
.mygo-downloads {
  height: 100%;
  overflow: auto;
  padding: 12px 0;
  header,
  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  header {
    justify-content: space-between;
  }
  h1 {
    margin: 0;
    font-size: 30px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 16px;
    margin: 12px 0;
    border: 1px solid var(--n-border-color, #8886);
    border-radius: 12px;
  }
  .filename {
    overflow-wrap: anywhere;
  }
  progress {
    width: 100%;
    accent-color: var(--n-primary-color, #4c9);
  }
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 16px;
    padding: 6px 14px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
}
</style>
