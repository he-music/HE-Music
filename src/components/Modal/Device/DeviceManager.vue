<template>
  <div class="device-manager">
    <!-- 加载状态 -->
    <n-spin v-if="loading" :show="true" class="loading-spin" />
    <!-- 设备列表 -->
    <template v-else>
      <n-text v-if="devices.length === 0" class="empty-tip" depth="3">
        {{ t("device.no_devices") }}
      </n-text>
      <n-scrollbar v-else max-height="400px">
        <n-list bordered>
          <n-list-item v-for="device in devices" :key="device.device_id">
            <n-thing>
              <template #header>
                <n-flex align="center" :size="8">
                  <n-text strong>{{ device.display_name }}</n-text>
                  <n-tag v-if="device.is_current_device" size="small" type="success">
                    {{ t("device.current_device") }}
                  </n-tag>
                </n-flex>
              </template>
              <template #header-extra>
                <n-popconfirm
                  v-if="!device.is_current_device"
                  @positive-click="handleDelete(device.device_id)"
                >
                  <template #trigger>
                    <n-button text type="error" size="small">
                      {{ t("device.delete") }}
                    </n-button>
                  </template>
                  {{ t("device.delete_confirm") }}
                </n-popconfirm>
              </template>
              <template #description>
                <n-flex vertical :size="4">
                  <n-text v-if="device.location" depth="3" style="font-size: 13px">
                    {{ device.location }}
                  </n-text>
                  <n-text depth="3" style="font-size: 13px">
                    {{ t("device.last_active") }}: {{ formatRelativeTime(device.last_active_at) }}
                  </n-text>
                </n-flex>
              </template>
            </n-thing>
          </n-list-item>
        </n-list>
      </n-scrollbar>
      <!-- 批量删除 -->
      <n-divider v-if="otherDevices.length > 0" />
      <n-popconfirm v-if="otherDevices.length > 0" @positive-click="handleBatchDelete">
        <template #trigger>
          <n-button type="error" secondary block :loading="batchDeleting">
            {{ t("device.delete_all") }} ({{ otherDevices.length }})
          </n-button>
        </template>
        {{ t("device.delete_all_confirm") }}
      </n-popconfirm>
    </template>
  </div>
</template>

<script setup lang="ts">
import { getUserDevices, deleteDevice, batchDeleteDevices } from "@/api/auth";
import type { Device } from "@/types/main.hemusic";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";
import { useI18n } from "vue-i18n";

dayjs.extend(relativeTime);

const { t } = useI18n();

defineEmits<{
  close: [];
}>();

const loading = ref(true);
const devices = ref<Device[]>([]);
const batchDeleting = ref(false);

const otherDevices = computed(() => devices.value.filter((d) => !d.is_current_device));

/** 格式化相对时间 */
const formatRelativeTime = (timestamp: number) => {
  if (!timestamp) return "-";
  return dayjs.unix(timestamp).fromNow();
};

/** 加载设备列表 */
const loadDevices = async () => {
  try {
    loading.value = true;
    const res = await getUserDevices();
    devices.value = res.devices || [];
  } catch (error) {
    console.error("获取设备列表失败：", error);
  } finally {
    loading.value = false;
  }
};

/** 删除单个设备 */
const handleDelete = async (deviceId: string) => {
  try {
    await deleteDevice(deviceId);
    devices.value = devices.value.filter((d) => d.device_id !== deviceId);
    window.$message.success(t("device.delete_success"));
  } catch (error) {
    console.error("删除设备失败：", error);
  }
};

/** 批量删除其他设备 */
const handleBatchDelete = async () => {
  try {
    batchDeleting.value = true;
    const res = await batchDeleteDevices();
    devices.value = devices.value.filter((d) => d.is_current_device);
    window.$message.success(t("device.delete_all_success"));
    console.log(`已删除 ${res.deleted_count} 个设备`);
  } catch (error) {
    console.error("批量删除设备失败：", error);
  } finally {
    batchDeleting.value = false;
  }
};

onMounted(() => {
  loadDevices();
});
</script>

<style lang="scss" scoped>
.device-manager {
  min-height: 200px;
  .loading-spin {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 200px;
  }
  .empty-tip {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 200px;
  }
}
</style>
