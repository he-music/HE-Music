<template>
  <DefaultLyric candidate-preview :clock="clock" :preview="preview" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useDocumentVisibility } from "@vueuse/core";
import DefaultLyric from "@/components/Player/PlayerLyric/DefaultLyric.vue";
import { useLyricPlaybackClock } from "@/components/LyricStage/useLyricPlaybackClock";
import { useStatusStore } from "@/stores/status";
import type { SongLyric } from "@/types/lyric";
import audioManager from "@/utils/audioManager";
import { usePlayer } from "@/utils/player";

const props = defineProps<{ lyrics: SongLyric; trackKey: string; visible: boolean }>();
const status = useStatusStore();
const player = usePlayer();
const visibility = useDocumentVisibility();

const preview = computed(() => ({
  lyrics: props.lyrics,
  playing: props.visible && status.playStatus,
}));

const clock = {
  time: useLyricPlaybackClock({
    playing: () => status.playStatus,
    visible: () => props.visible && visibility.value === "visible",
    identity: () => props.trackKey,
    // A candidate is compared with the audio, without the installed lyric's offset.
    offset: () => 0,
    readTime: () => player.getSeek(),
    subscribeSeek: (sample) => {
      audioManager.on("seeked", sample);
      audioManager.on("loadedmetadata", sample);
      return () => {
        audioManager.off("seeked", sample);
        audioManager.off("loadedmetadata", sample);
      };
    },
  }),
};
</script>
