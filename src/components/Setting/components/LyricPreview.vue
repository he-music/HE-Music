<template>
  <n-card
    id="lyrics-show"
    :content-style="{
      'flex-direction': 'column',
      'align-items': settingStore.lyricsPosition,
      '--font-weight': lyricFontStyle(settingStore.lyricFont).fontWeight,
      '--font-size': settingStore.lyricFontSize,
      '--font-tran-size': tranFontSize,
      '--font-roma-size': romaFontSize,
      '--transform-origin':
        settingStore.lyricsPosition === 'center'
          ? 'center'
          : settingStore.lyricsPosition === 'flex-start'
            ? 'left'
            : 'right',
      '--font-family': lyricFontStyle(settingStore.lyricFont).fontFamily,
      '--font-style': lyricFontStyle(settingStore.lyricFont).fontStyle,
    }"
    class="set-item"
  >
    <div v-if="settingStore.lyricRenderer === 'monet'" ref="previewRoot" class="monet-preview">
      <MonetLyricRail
        :lines="previewLines"
        :clock="previewClock"
        :playing="previewVisible && documentVisibility === 'visible'"
        :font-size="settingStore.lyricFontSize"
        :translation-size="settingStore.lyricTranFontSize"
        :romanization-size="settingStore.lyricRomaFontSize"
        :show-translation="settingStore.showTran"
        :show-romanization="settingStore.showRoma"
        :blur="settingStore.lyricsBlur"
        :align-position="settingStore.monetScrollOffset"
        :seek-label="t('setting.lyrics.monet_seek')"
        @seek="seekPreview"
      />
    </div>
    <n-card class="warning" v-if="settingStore.lyricRenderer === 'amll'">
      <n-text> {{ t("setting.lyric.preview_using_amll") }} </n-text>
    </n-card>
    <template v-if="settingStore.lyricRenderer !== 'monet'">
      <div v-for="item in 2" :key="item" :class="['lrc-item', { on: item === 2 }]">
        <n-text>我是一句歌词</n-text>
        <n-text v-if="settingStore.showTran">I'm the lyric</n-text>
        <n-text v-if="settingStore.showRoma">wo shi yi ju ge ci</n-text>
      </div>
    </template>
  </n-card>
</template>

<script setup lang="ts">
import { useSettingStore } from "@/stores";
import { useI18n } from "vue-i18n";
import { lyricFontStyle } from "@/utils/lyric/lyricFontConfig";
import { adaptMonetLines } from "@/components/Monet/model";

const MonetLyricRail = defineAsyncComponent(() => import("@/components/Monet/MonetLyricRail.vue"));
const previewTime = shallowRef(0);
const previewClock = { time: previewTime };
const previewRoot = ref<HTMLElement | null>(null);
const previewVisible = useElementVisibility(previewRoot);
const documentVisibility = useDocumentVisibility();
const previewLines = adaptMonetLines(
  ["让旋律轻轻流淌", "我是一句歌词", "让每一个字随音乐发光", "听见此刻的声音"].map(
    (text, index) => ({
      startTime: index * 4000,
      endTime: index * 4000 + 3500,
      words: Array.from(text).map((word, i) => ({
        word,
        startTime: index * 4000 + (i * 3500) / text.length,
        endTime: index * 4000 + ((i + 1) * 3500) / text.length,
      })),
      translatedLyric: "Let every word glow with the music",
      romanLyric: "rang xuan lü qing qing liu tang",
      isBG: false,
      isDuet: false,
    }),
  ),
  true,
);
let previewEpoch = 0;
function seekPreview(time: number) {
  previewTime.value = time;
  previewEpoch = performance.now() - time;
}

const settingStore = useSettingStore();
const { t } = useI18n();
const { pause: pausePreview, resume: resumePreview } = useRafFn(
  () => {
    previewTime.value = (performance.now() - previewEpoch) % 16000;
  },
  { immediate: false },
);
watch(
  () =>
    settingStore.lyricRenderer === "monet" &&
    previewVisible.value &&
    documentVisibility.value === "visible",
  (active) => {
    if (active) {
      previewEpoch = performance.now() - previewTime.value;
      resumePreview();
    } else pausePreview();
  },
  { immediate: true },
);

const fontSizeComputed = (key: string) =>
  computed({
    get: () =>
      settingStore.lyricRenderer === "amll"
        ? // AMLL 会为翻译和音译设置 `font-size: max(.5em, 10px);`
          Math.max(0.5 * settingStore.lyricFontSize, 10)
        : settingStore[key],
    set: (value) => (settingStore[key] = value),
  });

const tranFontSize = fontSizeComputed("lyricTranFontSize");
const romaFontSize = fontSizeComputed("lyricRomaFontSize");
</script>

<style scoped lang="scss">
#lyrics-show {
  .monet-preview {
    width: 100%;
    height: 320px;
    background: #24282c;
    border-radius: 12px;
    overflow: hidden;
  }
  .lrc-item {
    display: flex;
    flex-direction: column;
    opacity: 0.3;
    transform-origin: var(--transform-origin);
    transform: scale(0.86);
    transition: all 0.3s;
    &.on {
      opacity: 1;
      transform: scale(1);
    }
    .n-text {
      font-family: var(--font-family);
      &:nth-of-type(1) {
        font-weight: var(--font-weight);
        font-style: var(--font-style);
        font-size: calc(var(--font-size) * 1px);
      }
      &:nth-of-type(2) {
        opacity: 0.6;
        font-size: calc(var(--font-tran-size) * 1px);
      }
      &:nth-of-type(3) {
        opacity: 0.6;
        font-size: calc(var(--font-roma-size) * 1px);
      }
    }
  }
  .warning {
    border-radius: 8px;
    font-size: 16px;
    background-color: rgba(255, 255, 255, 0.1);
    margin-bottom: 4px;
    width: 100%;
    box-sizing: border-box;
  }
}
</style>
