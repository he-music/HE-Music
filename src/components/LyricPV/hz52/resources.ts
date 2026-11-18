import type { Container } from "pixi.js";
// 先解除过滤器与纹理的绑定，再释放距离场，供缩放重建与卸载共同使用。
export function release52HzFields(
  sprite: Pick<Container, "filters">,
  filter: { destroy(): void } | undefined,
  fields: { destroy(): void }[],
) {
  sprite.filters = [];
  filter?.destroy();
  fields.forEach((source) => source.destroy());
}
