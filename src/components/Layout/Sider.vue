<!-- 侧边栏 -->
<template>
  <div class="sider-all">
    <!-- Logo -->
    <div
      :class="[
        'logo',
        {
          collapsed: statusStore.menuCollapsed,
          'mac-traffic-light-safe': isElectron && isMac,
        },
      ]"
      @click="router.push('/')"
    >
      <Logo />
      <n-text>HEMusic</n-text>
    </div>
    <n-scrollbar
      :style="{
        maxHeight: `calc(100vh - ${musicStore.isHasPlayer && statusStore.showPlayBar ? 150 : 70}px)`,
      }"
    >
      <Menu />
    </n-scrollbar>
  </div>
</template>

<script setup lang="ts">
import { useMusicStore, useStatusStore } from "@/stores";
import { isElectron, isMac } from "@/utils/env";
import Logo from "@/components/Layout/Logo.vue";

const router = useRouter();
const musicStore = useMusicStore();
const statusStore = useStatusStore();
</script>

<style lang="scss" scoped>
.sider-all {
  display: flex;
  flex-direction: column;
  .logo {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 70px;
    padding: 0 1rem;
    transition: transform 0.3s;
    cursor: pointer;
    &.mac-traffic-light-safe {
      justify-content: flex-start;
      padding-left: 88px;
      padding-right: 12px;
    }
    .n-text {
      width: 90px;
      font-size: 22px;
      // font-weight: bold;
      font-family: "logo";
      margin-left: 8px;
      margin-top: 2px;
      line-height: 40px;
      line-height: 40px;
      overflow: hidden;
      transition:
        width 0.3s,
        opacity 0.3s,
        margin 0.3s;
    }
    &.collapsed {
      justify-content: center;
      padding-left: 1rem;
      padding-right: 1rem;
      .n-text {
        width: 0;
        opacity: 0;
        margin-left: 0;
      }
    }
    &:hover {
      transform: scale(1.05);
    }
    &:active {
      transform: scale(1);
    }
  }
}
</style>
