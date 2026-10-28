import { describe, expect, it } from "vitest";
import {
  createDefaultDesktopLyricStyle,
  isDesktopLyricColor,
  parseDesktopLyricStyle,
} from "./desktopLyricStyle";

// 与 desktop/lyrics_style_test.go 保持相同的 golden 输入与预期。
const validColors = [
  "#abc",
  "#ABCD",
  "#fe7971",
  "#AABBCCDD",
  "rgb(0,255,1)",
  "RGB( 255 , 0 , 001 )",
  "rgba(0, 0, 0, 0.5)",
  "RGBA(255,0,10,.5)",
  "rgba(0,0,0,0)",
  "rgba(0,0,0,1)",
  "rgba(0,0,0,1.000000)",
  "rgba(0,0,0,0.123456)",
  "rgba(0,0,0,.000001)",
  `rgb(${" ".repeat(54)}0,0,0)`,
];
const invalidColors = [
  "",
  "#ab",
  "#abcde",
  "#abcdefg",
  "#123456789",
  "#ggg",
  "red",
  "transparent",
  "url(x)",
  "var(--color)",
  "#abc; color:red",
  "rgb(0,0,0);background:url(x)",
  "rgb(256,0,0)",
  "rgb(0,256,0)",
  "rgb(0,0,256)",
  "rgb(-1,0,0)",
  "rgb(+1,0,0)",
  "rgb(1.0,0,0)",
  "rgb(0000,0,0)",
  "rgb(10%,0,0)",
  "rgb(0 0 0)",
  "rgb(0,0,0,1)",
  "rgba(0,0,0)",
  "rgba(0,0,0,-.1)",
  "rgba(0,0,0,1.000001)",
  "rgba(0,0,0,0.1234567)",
  "rgba(0,0,0,.1234567)",
  "rgba(0,0,0,00.5)",
  "rgba(0,0,0,2)",
  "rgba(0,0,0,1.)",
  "rgba(0,0,0,.)",
  "rgba(0,0,0,NaN)",
  "rgba(0,0,0,Infinity)",
  "rgba(0,0,0,1e-1)",
  "rgba(0,0,0,50%)",
  " rgb(0,0,0)",
  "rgb(0,0,0) ",
  "rgb (0,0,0)",
  "#abc\n",
  "rgb(0,0,0)\n",
  "rgb(0,\t0,0)",
  "rgb(0,\r0,0)",
  "rgb(0,\n0,0)",
  "rgb(0,\u00000,0)",
  "rgb(0,\u00a00,0)",
  "rgb(0,\u20030,0)",
  "rgb(０,0,0)",
  `rgb(${" ".repeat(55)}0,0,0)`,
];
const colorFields = ["playedColor", "unplayedColor", "shadowColor"] as const;

describe("isDesktopLyricColor", () => {
  it.each(validColors)("接受 golden %j", (value) => {
    expect(isDesktopLyricColor(value)).toBe(true);
  });
  it.each(invalidColors)("拒绝 golden %j", (value) => {
    expect(isDesktopLyricColor(value)).toBe(false);
  });
  it.each([null, undefined, 123, true, {}, [], new String("#abc")])("拒绝非字符串 %j", (value) => {
    expect(isDesktopLyricColor(value)).toBe(false);
  });
});

describe("DesktopLyricStyle", () => {
  it("每次创建独立默认值，兼容旧的空样式对象", () => {
    const first = createDefaultDesktopLyricStyle();
    const second = createDefaultDesktopLyricStyle();
    expect(first).toEqual({
      playedColor: "#fe7971",
      unplayedColor: "#ccc",
      shadowColor: "rgba(0, 0, 0, 0.5)",
      textBackgroundMask: false,
    });
    expect(parseDesktopLyricStyle({})).toEqual(second);
    first.playedColor = "#000";
    expect(second.playedColor).toBe("#fe7971");
  });

  it.each(colorFields)("%s 接受部分字段、补默认并拒绝非法值", (field) => {
    for (const color of validColors) {
      expect(parseDesktopLyricStyle({ [field]: color })).toEqual({
        ...createDefaultDesktopLyricStyle(),
        [field]: color,
      });
    }
    for (const color of [...invalidColors, undefined, null, 1, false]) {
      expect(parseDesktopLyricStyle({ [field]: color })).toBeUndefined();
    }
  });

  it("保留 true/false 与透明色，解析结果与调用方无别名", () => {
    const input = Object.freeze({
      playedColor: "#abcd",
      unplayedColor: "#aabbcc00",
      shadowColor: "rgba(0,0,0,0)",
      textBackgroundMask: false,
    });
    const parsed = parseDesktopLyricStyle(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    if (!parsed) throw new Error("有效样式解析失败");
    parsed.playedColor = "#000";
    expect(input.playedColor).toBe("#abcd");
    const mutable = { playedColor: "#123" };
    const copy = parseDesktopLyricStyle(mutable);
    mutable.playedColor = "#456";
    expect(copy?.playedColor).toBe("#123");
    expect(parseDesktopLyricStyle({ textBackgroundMask: true })?.textBackgroundMask).toBe(true);
    for (const value of [undefined, null, 0, 1, "false", {}]) {
      expect(parseDesktopLyricStyle({ textBackgroundMask: value })).toBeUndefined();
    }
  });

  it("拒绝非对象、未知字段、自有原型键与自定义原型", () => {
    for (const value of [undefined, null, true, 1, "{}", [], new Date()]) {
      expect(parseDesktopLyricStyle(value)).toBeUndefined();
    }
    for (const key of [
      "unknown",
      "__proto__",
      "constructor",
      "prototype",
      "font",
      Symbol("extra"),
    ]) {
      const input = Object.defineProperty({}, key, { value: "#abc", enumerable: false });
      expect(parseDesktopLyricStyle(input)).toBeUndefined();
    }
    expect(parseDesktopLyricStyle(JSON.parse('{"__proto__":{}}'))).toBeUndefined();
    expect(parseDesktopLyricStyle(Object.create({ playedColor: "#abc" }))).toBeUndefined();
    expect(parseDesktopLyricStyle(Object.create(null))).toEqual(createDefaultDesktopLyricStyle());
  });

  it("拒绝访问器而不执行调用方 getter", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "playedColor", {
      get() {
        reads++;
        return "#abc";
      },
    });
    expect(parseDesktopLyricStyle(input)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
