<template>
  <div class="monet-floating-decor" aria-hidden="true">
    <div
      v-for="p in particles"
      :key="p.id"
      :class="['decor-particle', { reverse: p.reverse }]"
      :style="{
        left: `${p.x}%`,
        top: `${p.y}%`,
        opacity: p.opacity,
        '--p-rot': `${p.rotation}deg`,
        animationDuration: `${p.duration}s`,
        animationDelay: `${p.delay}s`,
        animationPlayState: playing ? 'running' : 'paused',
      }"
    >
      <svg
        :width="p.size"
        :height="p.size"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M12 3C14.5 5.5 16.8 9 16 14C15.2 19 13.5 21 12 21C10.5 21 8.8 19 8 14C7.2 9 9.5 5.5 12 3Z"
          :fill="petalFill"
        />
        <path
          d="M12 6C12 6 11.3 10.5 11.3 14.5C11.3 17.5 12 20 12 20"
          :stroke="petalStroke"
          stroke-width="0.45"
          stroke-linecap="round"
        />
      </svg>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

// 移植自 Folia (chthollyphile, AGPL-3.0) MonetFloatingDecor.tsx
const props = withDefaults(
  defineProps<{
    color?: string; // "r, g, b"
    playing?: boolean;
  }>(),
  {
    color: "239, 239, 239",
    playing: true,
  },
);

const petalFill = computed(() => `rgba(${props.color}, 0.28)`);
const petalStroke = computed(() => `rgba(${props.color}, 0.45)`);

const PARTICLE_COUNT = 10;

interface FloatingParticle {
  id: number;
  x: number;
  y: number;
  size: number;
  rotation: number;
  duration: number;
  delay: number;
  opacity: number;
  reverse: boolean;
}

const particles: FloatingParticle[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
  id: i,
  x: ((i * 127 + 43) % 80) + 10,
  y: ((i * 211 + 17) % 80) + 5,
  size: 38 + ((i * 53) % 36),
  rotation: (i * 97) % 360,
  duration: 22 + ((i * 71) % 20),
  delay: ((i * 41) % 80) / 10,
  opacity: 0.12 + ((i * 31) % 15) / 100,
  reverse: i % 2 === 0,
}));
</script>

<style scoped lang="scss">
.monet-floating-decor {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.decor-particle {
  position: absolute;
  transform-origin: center center;
  will-change: transform, opacity;
  animation-name: floatParticleNormal;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;

  &.reverse {
    animation-name: floatParticleReverse;
  }
}

@media (prefers-reduced-motion: reduce) {
  .decor-particle {
    animation: none !important;
  }
}

@keyframes floatParticleNormal {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(var(--p-rot, 0deg));
  }
  25% {
    transform: translate3d(-18px, 40px, 0) rotate(calc(var(--p-rot, 0deg) + 120deg));
  }
  50% {
    transform: translate3d(24px, -50px, 0) rotate(calc(var(--p-rot, 0deg) + 60deg));
  }
  75% {
    transform: translate3d(-12px, 20px, 0) rotate(calc(var(--p-rot, 0deg) + 180deg));
  }
}

@keyframes floatParticleReverse {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(var(--p-rot, 0deg));
  }
  25% {
    transform: translate3d(18px, -40px, 0) rotate(calc(var(--p-rot, 0deg) - 120deg));
  }
  50% {
    transform: translate3d(-24px, 50px, 0) rotate(calc(var(--p-rot, 0deg) - 60deg));
  }
  75% {
    transform: translate3d(12px, -20px, 0) rotate(calc(var(--p-rot, 0deg) - 180deg));
  }
}
</style>
