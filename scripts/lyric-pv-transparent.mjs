// 透明宿主不需要原版暗场里的铺底薄烟，光束内部的体积光和粒子保持原样。
export function removePVBackgroundHaze(path, source) {
  const changes = {
    "components/visualizer/lumiere/light/lightFieldShader.ts": [
      ["light += uFogColor * density * uFogB.z;", "// HE-Music：透明叠加时不在光束外铺烟雾底色。"],
      [
        "c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;",
        "c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0 * min(1.0, peak * 255.0);",
      ],
    ],
    "components/visualizer/hanabi/mg/ambient.ts": [
      ["const smoke = dots(Math.round(5 * Math.min(1.5, density)),", "const smoke = dots(0,"],
    ],
  };
  for (const [match, replacement] of changes[path] ?? []) {
    if (!source.includes(match)) throw new Error(`上游透明适配位置已变化：${path}`);
    source = source.replace(match, replacement);
  }
  return source;
}
