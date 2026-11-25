<template>
  <main
    v-if="view"
    class="mini-player"
    :data-theme="view.playback.theme"
    :aria-label="t('miniPlayer.title')"
    @keydown.esc.prevent="send('close')"
  >
    <button
      type="button"
      class="cover"
      :aria-label="t('nav.show_main_window')"
      :title="t('nav.show_main_window')"
      @click="send('show-main')"
    >
      <i class="icon music" aria-hidden="true" />
      <img
        v-if="view.playback.artwork && failedArtwork !== view.playback.artwork"
        :key="view.playback.artwork"
        :src="view.playback.artwork"
        alt=""
        draggable="false"
        @error="failedArtwork = view.playback.artwork"
      />
    </button>
    <div class="body">
      <header class="heading">
        <div class="metadata">
          <div class="title" :title="view.playback.title">
            {{ view.playback.title || t("miniPlayer.no_song") }}
          </div>
          <div class="artist" :title="view.playback.artist" role="status">
            {{ failed ? t("miniPlayer.operation_failed") : view.playback.artist }}
          </div>
        </div>
        <button
          type="button"
          :aria-pressed="view.pinned"
          :aria-label="t('miniPlayer.pin')"
          :title="t('miniPlayer.pin')"
          @click="send('pin')"
        >
          <i class="icon pin" aria-hidden="true" />
        </button>
        <button
          type="button"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          @click="send('close')"
        >
          <i class="icon close" aria-hidden="true" />
        </button>
      </header>
      <div class="controls">
        <button
          type="button"
          :disabled="!view.playback.canPrevious"
          :aria-label="t('common.play_prev')"
          :title="t('common.play_prev')"
          @click="send('previous')"
        >
          <i class="icon previous" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="playback"
          :disabled="!view.playback.trackKey"
          :aria-label="playbackLabel"
          :title="playbackLabel"
          @click="send('toggle')"
        >
          <i :class="['icon', view.playback.playing ? 'pause' : 'play']" aria-hidden="true" />
        </button>
        <button
          type="button"
          :disabled="!view.playback.canNext"
          :aria-label="t('common.play_next')"
          :title="t('common.play_next')"
          @click="send('next')"
        >
          <i class="icon next" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="favorite-button"
          :disabled="!view.playback.canFavorite"
          :aria-label="favoriteLabel"
          :title="favoriteLabel"
          @click="send('favorite')"
        >
          <i
            :class="['icon', view.playback.favorite ? 'favorite' : 'unfavorite']"
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { mygoMiniPlayer } from "@/platform/miniPlayer";
import type { MiniPlayerAction, MiniPlayerView } from "@/platform/mygo.bindings";

const { t, locale } = useI18n();
const view = shallowRef<MiniPlayerView>();
const failed = shallowRef(false);
const failedArtwork = shallowRef("");
const playbackLabel = computed(() =>
  t(view.value?.playback.playing ? "common.pause" : "common.play"),
);
const favoriteLabel = computed(() =>
  t(view.value?.playback.favorite ? "common.remove_from_favorites" : "common.add_to_favorites"),
);
let disposed = false;
let offView: (() => void) | undefined;
let sending = false;

function apply(next: MiniPlayerView) {
  if (disposed) return;
  const current = view.value;
  if (current && (next.generation !== current.generation || next.revision <= current.revision))
    return;
  if (next.playback.artwork !== current?.playback.artwork) failedArtwork.value = "";
  locale.value = next.playback.language === "en" ? "en" : "zh-CN";
  view.value = next;
}

async function send(action: MiniPlayerAction) {
  const current = view.value;
  if (!current || (sending && action !== "close")) return;
  sending = true;
  failed.value = false;
  try {
    await mygoMiniPlayer.command({
      generation: current.generation,
      revision: current.revision,
      action,
    });
  } catch (error) {
    if (!disposed && action !== "close") {
      failed.value = true;
      console.error("迷你播放器操作失败", error);
    }
  } finally {
    sending = false;
  }
}

onMounted(() => {
  offView = mygoMiniPlayer.onView(apply);
  void mygoMiniPlayer
    .attach()
    .then(async (initial) => {
      if (disposed) return;
      apply(initial);
      // 隐藏的 WebView 可能不运行动画帧。等待 DOM 更新即可，不依赖绘制时钟或网络封面。
      await nextTick();
      if (!disposed) await mygoMiniPlayer.rendered(initial.generation);
    })
    .catch((error: unknown) => {
      if (!disposed) console.error("迷你播放器连接失败", error);
    });
});
onBeforeUnmount(() => {
  disposed = true;
  offView?.();
});
</script>

<style>
html.mini-player-window,
.mini-player-window body,
.mini-player-window #app {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
</style>

<style scoped lang="scss">
@mixin dark-palette {
  color-scheme: dark;
  --surface: #191a1f;
  --text: #f6f6fa;
  --secondary: #b6bbcd;
  --outline: #3a3e4a;
  --accent: #ffabb9;
  --tint: #4c2934;
}

.mini-player {
  color-scheme: light;
  --surface: #f7f8fc;
  --text: #1e2130;
  --secondary: #555a70;
  --outline: #dce0eb;
  --accent: #9a3349;
  --tint: #f4dce3;
  box-sizing: border-box;
  height: 100%;
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 12px;
  border: 1px solid var(--outline);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  font:
    14px/1.35 system-ui,
    sans-serif;
  user-select: none;
  -webkit-app-region: drag;
  --app-region: drag;
}
.mini-player[data-theme="dark"] {
  @include dark-palette;
}
@media (prefers-color-scheme: dark) {
  .mini-player[data-theme="system"] {
    @include dark-palette;
  }
}
.body {
  min-width: 0;
}
.heading,
.controls {
  display: flex;
  align-items: center;
  gap: 4px;
}
.metadata {
  min-width: 0;
  flex: 1;
}
.title,
.artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title {
  font-weight: 650;
}
.artist {
  min-height: 1.35em;
  font-size: 12px;
  color: var(--secondary);
}
.controls {
  margin-top: 2px;
}
button {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--secondary);
  cursor: pointer;
  -webkit-app-region: no-drag;
  --app-region: no-drag;
}
button:is(:hover, :focus-visible):not(:disabled) {
  background: var(--tint);
  color: var(--accent);
}
button:active:not(:disabled) {
  opacity: 0.75;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
button:disabled {
  opacity: 0.38;
  cursor: default;
}
button[aria-pressed="true"],
.playback {
  color: var(--accent);
  background: var(--tint);
}
.playback {
  width: 38px;
}
.favorite-button {
  margin-left: auto;
}
.favorite {
  color: var(--accent);
}
.cover {
  width: 60px;
  height: 60px;
  background: var(--tint);
  color: var(--accent);
}
.cover img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}
.icon {
  width: 18px;
  height: 18px;
  display: block;
  background: currentColor;
  -webkit-mask: var(--icon) center / contain no-repeat;
  mask: var(--icon) center / contain no-repeat;
}
.cover .icon,
.playback .icon {
  width: 22px;
  height: 22px;
}
.icon.music {
  --icon: url("@/assets/icons/Music.svg");
}
.icon.pin {
  --icon: url("@/assets/icons/PushPin.svg");
}
.icon.close {
  --icon: url("@/assets/icons/Close.svg");
}
.icon.previous {
  --icon: url("@/assets/icons/SkipPrev.svg");
}
.icon.play {
  --icon: url("@/assets/icons/Play.svg");
}
.icon.pause {
  --icon: url("@/assets/icons/Pause.svg");
}
.icon.next {
  --icon: url("@/assets/icons/SkipNext.svg");
}
.icon.favorite {
  --icon: url("@/assets/icons/Favorite.svg");
}
.icon.unfavorite {
  --icon: url("@/assets/icons/FavoriteBorder.svg");
}
</style>
