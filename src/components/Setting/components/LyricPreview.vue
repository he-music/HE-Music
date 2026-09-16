<template>
  <n-card
    id="lyrics-show"
    ref="previewRoot"
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
    <div
      v-if="settingStore.lyricRenderer === 'monet'"
      class="monet-preview"
      :style="{ '--main-cover-color': previewMainColor }"
    >
      <MonetLyricRail
        :lines="previewLines"
        :clock="previewClock"
        :playing="previewVisible && documentVisibility === 'visible'"
        :word-animation="settingStore.showYrcAnimation"
        :long-word-effect="settingStore.showYrcLongEffect"
        :color="previewMainColor"
        :text-align="
          settingStore.lyricsPosition === 'center'
            ? 'center'
            : settingStore.lyricsPosition === 'flex-end'
              ? 'right'
              : 'left'
        "
        :style="{ ...lyricFontStyle(settingStore.lyricFont), ...lyricLangFontStyle(settingStore) }"
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
    <div
      v-if="settingStore.lyricRenderer === 'partita'"
      class="monet-preview"
      :style="{ '--main-cover-color': previewMainColor }"
    >
      <PartitaLyricRail
        :lines="partitaPreviewLines"
        :clock="previewClock"
        :playing="previewVisible && documentVisibility === 'visible'"
        :word-animation="settingStore.showYrcAnimation"
        :font-size="settingStore.lyricFontSize"
        :translation-size="settingStore.lyricTranFontSize"
        :romanization-size="settingStore.lyricRomaFontSize"
        :show-translation="settingStore.showTran"
        :show-romanization="settingStore.showRoma"
        :show-guide-lines="settingStore.showPartitaGuideLines"
        :show-upcoming="settingStore.showPartitaUpcoming"
        :stagger-min="settingStore.partitaStagger * 0.6"
        :stagger-max="settingStore.partitaStagger * 1.4"
        :color="previewMainColor"
        @seek="seekPreview"
      />
    </div>
    <div
      v-if="settingStore.lyricRenderer === 'classic'"
      class="monet-preview"
      :style="{ '--main-cover-color': previewMainColor }"
    >
      <ClassicLyricRail
        :lines="classicPreviewLines"
        :clock="previewClock"
        :playing="previewVisible && documentVisibility === 'visible'"
        :word-animation="settingStore.showYrcAnimation"
        :font-size="settingStore.lyricFontSize"
        :translation-size="settingStore.lyricTranFontSize"
        :romanization-size="settingStore.lyricRomaFontSize"
        :show-translation="settingStore.showTran"
        :show-romanization="settingStore.showRoma"
        :show-upcoming="settingStore.classicShowUpcoming"
        :enable-word-rotation="settingStore.classicWordRotation"
        :breathing-float-multiplier="settingStore.classicBreathingFloat"
        :word-spacing="settingStore.classicWordSpacing"
        :main-color="previewMainColor"
        :accent-color="previewAccentColor"
        :empty-text="t('setting.lyrics.classic_empty')"
        :seek-label="t('setting.lyrics.classic_seek')"
        @seek="seekPreview"
      />
    </div>
    <div
      v-if="settingStore.lyricRenderer === 'amll'"
      class="monet-preview"
      :style="{ '--main-cover-color': previewMainColor }"
    >
      <LyricPlayer
        class="amll-preview"
        :lyric-lines="amllPreviewLines"
        :current-time="Math.floor(previewTime)"
        :playing="previewActive"
        :disabled="!previewActive"
        :enable-spring="settingStore.useAMSpring"
        :enable-scale="settingStore.useAMSpring"
        :enable-blur="settingStore.lyricsBlur"
        :align-position="settingStore.lyricsScrollOffset"
        :align-anchor="settingStore.lyricsScrollOffset > 0.4 ? 'center' : 'top'"
        :hide-passed-lines="settingStore.AMHidePassedLines"
        :word-fade-width="settingStore.AMWordFadeWidth"
        :style="{
          '--amll-lp-font-size': `${settingStore.lyricFontSize}px`,
          '--amll-lp-color': `rgb(${previewMainColor})`,
          ...lyricFontStyle(settingStore.lyricFont),
        }"
        @line-click="seekPreview($event.line.getLine().startTime)"
      />
    </div>
    <div
      v-if="settingStore.lyricRenderer === 'default'"
      class="monet-preview"
      :style="{ '--main-cover-color': previewMainColor }"
    >
      <DefaultLyric
        :current-time="previewTime"
        :preview="defaultPreview"
        @preview-seek="seekPreview"
      />
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { useSettingStore, useStatusStore } from "@/stores";
import { useI18n } from "vue-i18n";
import { lyricFontStyle, lyricLangFontStyle } from "@/utils/lyric/lyricFontConfig";
import { adaptMonetLines } from "@/components/Monet/model";
import { adaptPartitaLines } from "@/components/Partita/model";
import { adaptClassicLines } from "@/components/Classic/model";

const DefaultLyric = defineAsyncComponent(
  () => import("@/components/Player/PlayerLyric/DefaultLyric.vue"),
);
const LyricPlayer = defineAsyncComponent(() => import("@/components/AMLL/LyricPlayer.vue"));
const MonetLyricRail = defineAsyncComponent(() => import("@/components/Monet/MonetLyricRail.vue"));
const PartitaLyricRail = defineAsyncComponent(
  () => import("@/components/Partita/PartitaLyricRail.vue"),
);
const ClassicLyricRail = defineAsyncComponent(
  () => import("@/components/Classic/ClassicLyricRail.vue"),
);
const statusStore = useStatusStore();
const settingStore = useSettingStore();
const { t } = useI18n();

const previewMainColor = computed(() => {
  const main = statusStore.playerMainColor;
  return main ? `${main.r}, ${main.g}, ${main.b}` : "239, 239, 239";
});

const previewAccentColor = computed(() => {
  if (settingStore.playerMainColorType === "follow-cover") {
    const primary = statusStore.songCoverTheme?.light?.primary;
    if (primary) return `${primary.r}, ${primary.g}, ${primary.b}`;
  }
  const main = statusStore.playerMainColor;
  return main ? `${main.r}, ${main.g}, ${main.b}` : "255, 255, 255";
});
const previewTime = shallowRef(0);
const previewClock = { time: previewTime };
const previewRoot = ref<HTMLElement | null>(null);
const previewVisible = useElementVisibility(previewRoot);
const documentVisibility = useDocumentVisibility();
const previewSource = [
  "让旋律轻轻流淌",
  "我是一句歌词",
  "让每一个字随音乐发光",
  "听见此刻的声音",
].map((text, index) => ({
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
}));
const previewLines = computed(() => adaptMonetLines(previewSource, settingStore.showYrc));
const partitaPreviewLines = computed(() => adaptPartitaLines(previewSource, settingStore.showYrc));
const classicPreviewLines = computed(() => adaptClassicLines(previewSource, settingStore.showYrc));
let previewEpoch = 0;
function seekPreview(time: number) {
  previewTime.value = time;
  previewEpoch = performance.now() - time;
}

const amllPreviewLines = computed(() =>
  previewSource.map((line) => ({
    ...line,
    words: settingStore.showYrc
      ? line.words.map((word) => ({ ...word }))
      : [
          {
            word: line.words.map((word) => word.word).join(""),
            startTime: line.startTime,
            endTime: line.endTime,
          },
        ],
    translatedLyric: settingStore.showTran ? line.translatedLyric : "",
    romanLyric: settingStore.showRoma ? line.romanLyric : "",
  })),
);
const previewActive = computed(
  () => previewVisible.value && documentVisibility.value === "visible",
);
const defaultPreviewLyrics = {
  yrcData: previewSource,
  lrcData: previewSource.map((line) => ({
    ...line,
    words: [
      {
        word: line.words.map((word) => word.word).join(""),
        startTime: line.startTime,
        endTime: line.endTime,
      },
    ],
  })),
};
const defaultPreview = computed(() => ({
  lyrics: defaultPreviewLyrics,
  playing: previewActive.value,
}));
const { pause: pausePreview, resume: resumePreview } = useRafFn(
  () => {
    previewTime.value = (performance.now() - previewEpoch) % 16000;
  },
  { immediate: false },
);
watch(
  previewActive,
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
    --main-cover-color: 239, 239, 239;
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
  .amll-preview {
    width: 100%;
    height: 100%;
    --amll-lp-color: #efefef;
    --amll-lp-hover-bg-color: rgba(255, 255, 255, 0.08);
  }
}
</style>
