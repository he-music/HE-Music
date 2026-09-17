import { onMounted, onUpdated, watch, type Ref } from "vue";
import { useDocumentVisibility, useElementVisibility } from "@vueuse/core";
import { resolveGlow } from "../Monet/motion";

// src/components/LyricStage/useStageGlow.ts — 复用绝对时间辉光包络，不通过 Vue 每帧渲染字形。
export function useStageGlow(root: Ref<HTMLElement | null>, clock: Readonly<Ref<number>>) {
  const documentVisibility = useDocumentVisibility();
  const visible = useElementVisibility(root);
  let glyphs: { node: HTMLElement; start: number; end: number; lineEnd: number }[] = [];

  function paint(time: number) {
    if (documentVisibility.value !== "visible" || !visible.value) return;
    for (const glyph of glyphs) {
      glyph.node.style.opacity = String(resolveGlow(time, glyph.start, glyph.end, glyph.lineEnd));
    }
  }

  function refresh() {
    glyphs = Array.from(
      root.value?.querySelectorAll<HTMLElement>("[data-stage-glyph]") ?? [],
      (node) => ({
        node,
        start: Number(node.dataset.start),
        end: Number(node.dataset.end),
        lineEnd: Number(node.dataset.lineEnd),
      }),
    );
    paint(clock.value);
  }

  watch(clock, paint, { flush: "post" });
  watch([visible, documentVisibility], () => paint(clock.value));
  onMounted(refresh);
  onUpdated(refresh);
  return refresh;
}
