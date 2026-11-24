<template>
  <span class="skin-preview" :style="previewStyle" aria-hidden="true">
    <span class="window-sidebar"><span /><span /><span /></span>
    <span class="window-content"><span /><span /><span /></span>
    <span class="window-footer"><span /></span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import apricotBloomScene from "@/assets/skins/apricot-bloom.webp";
import iceLakeScene from "@/assets/skins/ice-lake.webp";
import pineAfterRainScene from "@/assets/skins/pine-after-rain.webp";
import { getImmersiveSkin, type ImmersiveSkin } from "@/theme/skins";

const props = defineProps<{ skin: ImmersiveSkin }>();

const skinScenes: Record<Exclude<ImmersiveSkin, "none">, string> = {
  "apricot-bloom": apricotBloomScene,
  "ice-lake": iceLakeScene,
  "pine-after-rain": pineAfterRainScene,
};
const previewStyle = computed(() => {
  if (props.skin === "none") return;
  const skin = getImmersiveSkin(props.skin);
  if (!skin) return;
  return {
    "--preview-scene": `url("${skinScenes[props.skin]}")`,
    "--preview-base": `rgb(${skin.cssVariables["--skin-base-rgb"]})`,
    "--preview-accent": `rgb(${skin.cssVariables["--skin-primary-rgb"]})`,
    "--preview-text": skin.cssVariables["--skin-text"],
  };
});
</script>

<style lang="scss" scoped>
.skin-preview {
  --preview-scene: none;
  --preview-base: #343e4c;
  --preview-accent: #b8c6da;
  --preview-text: #f0f3f8;
  display: grid;
  grid-template: minmax(0, 1fr) 12px / 25% 1fr;
  aspect-ratio: 16 / 9;
  min-width: 0;
  overflow: hidden;
  border-radius: 6px;
  color: var(--preview-text);
  background: var(--preview-base) var(--preview-scene) center / cover no-repeat;
  pointer-events: none;
}

.window-sidebar,
.window-content {
  display: grid;
  align-content: center;
  gap: 10%;
  padding: 12%;

  span {
    height: 4px;
    border-radius: 3px;
    background: currentColor;
    opacity: 0.75;
  }
}

.window-sidebar {
  justify-items: center;
  background: color-mix(in srgb, var(--preview-base) 75%, transparent);

  span {
    width: 70%;
  }
}

.window-content {
  align-self: center;
  width: 62%;
  padding: 10% 14%;
  background: color-mix(in srgb, var(--preview-base) 38%, transparent);

  span:nth-child(2) {
    width: 78%;
  }
  span:nth-child(3) {
    width: 58%;
  }
}

.window-footer {
  display: grid;
  grid-column: 1 / -1;
  place-items: center;
  background: color-mix(in srgb, var(--preview-base) 85%, transparent);

  span {
    width: 52%;
    height: 2px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--preview-accent) 42%, currentColor 42%);
  }
}
</style>
