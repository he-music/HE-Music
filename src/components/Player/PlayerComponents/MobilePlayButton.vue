<template>
  <n-button
    :loading="statusStore.playLoading"
    :aria-label="t(statusStore.playStatus ? 'common.pause' : 'common.play')"
    :class="['mobile-play-button', { compact }]"
    type="primary"
    strong
    secondary
    circle
    @click.stop="player.playOrPause()"
  >
    <template #icon>
      <Transition name="fade" mode="out-in">
        <SvgIcon
          :key="statusStore.playStatus ? 'Pause' : 'Play'"
          :name="statusStore.playStatus ? 'Pause' : 'Play'"
          :size="compact ? 32 : 40"
        />
      </Transition>
    </template>
  </n-button>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useStatusStore } from "@/stores";
import { usePlayer } from "@/utils/player";

defineProps<{ compact?: boolean }>();
const statusStore = useStatusStore();
const player = usePlayer();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.mobile-play-button {
  width: 60px;
  height: 60px;
  font-size: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.2s;
  background-color: rgba(var(--main-cover-color), 0.2);
  color: rgb(var(--main-cover-color));
  &.n-button--primary-type {
    --n-color: rgba(var(--main-cover-color), 0.14);
    --n-color-hover: rgba(var(--main-cover-color), 0.2);
    --n-color-focus: rgba(var(--main-cover-color), 0.2);
    --n-color-pressed: rgba(var(--main-cover-color), 0.12);
  }
  &.compact {
    width: 48px;
    height: 48px;
  }
  &:active {
    transform: scale(0.95);
  }
}
</style>
