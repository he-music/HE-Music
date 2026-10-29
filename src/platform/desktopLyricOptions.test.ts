import { describe, expect, it } from "vitest";
import { createDefaultDesktopLyricOptions, parseDesktopLyricOptions } from "./desktopLyricOptions";

// 与 desktop/lyrics_options_test.go 使用相同 golden，均在完整默认对象上替换字段。
const validNames = [
  "system-ui",
  "Arial",
  "Noto Sans SC",
  "思源黑体",
  "字体_Font-2.0",
  "Ａ１２",
  "Ⅳ²",
  "A".repeat(256),
  "中".repeat(85) + "A",
  "𠮷".repeat(64),
];
const invalidNames = [
  "",
  " Arial",
  "Arial ",
  " ",
  "Arial, sans-serif",
  "url(x)",
  "var(--font)",
  "Arial; color:red",
  "Font(x)",
  "Font/x",
  "Font\\x",
  '"Arial"',
  "'Arial'",
  "Font\n",
  "Font\r",
  "Font\t",
  "Font\u0000",
  "Font\u007f",
  "Font\u00a0",
  "Font\u2003",
  "e\u0301",
  "😀",
  "\ud800",
  "A".repeat(257),
  "中".repeat(86),
  "𠮷".repeat(64) + "A",
];
const booleanFields: (keyof Omit<
  ReturnType<typeof createDefaultDesktopLyricOptions>,
  "font" | "position"
>)[] = ["isDoubleLine", "limitBounds", "showYrc", "showTran", "animation", "alwaysShowPlayInfo"];

function withFont(field: string, value: unknown) {
  const defaults = createDefaultDesktopLyricOptions();
  return { ...defaults, font: { ...defaults.font, [field]: value } };
}

describe("DesktopLyricOptions", () => {
  it("默认值与 lyricConfig 一致且每次深分离", () => {
    const first = createDefaultDesktopLyricOptions();
    const second = createDefaultDesktopLyricOptions();
    expect(first).toEqual({
      font: {
        family: "system-ui",
        size: 24,
        weight: 700,
        postScriptName: "system-ui",
        style: "normal",
      },
      isDoubleLine: true,
      position: "both",
      limitBounds: false,
      showYrc: true,
      showTran: true,
      animation: true,
      alwaysShowPlayInfo: false,
    });
    expect(first).not.toBe(second);
    expect(first.font).not.toBe(second.font);
    first.font.family = "Arial";
    expect(second.font.family).toBe("system-ui");
  });

  it("TS 独有的部分字段补默认，font 也补默认", () => {
    const defaults = createDefaultDesktopLyricOptions();
    expect(parseDesktopLyricOptions({})).toEqual(defaults);
    expect(parseDesktopLyricOptions({ font: {} })).toEqual(defaults);
    expect(parseDesktopLyricOptions({ font: { size: 20 }, showTran: false })).toEqual({
      ...defaults,
      font: { ...defaults.font, size: 20 },
      showTran: false,
    });
    expect(parseDesktopLyricOptions(Object.create(null))).toEqual(defaults);
    expect(parseDesktopLyricOptions({ font: Object.create(null) })).toEqual(defaults);
  });

  it.each(["family", "postScriptName"])("%s 字体名 golden", (field) => {
    for (const value of validNames) {
      const input = withFont(field, value);
      expect(parseDesktopLyricOptions(input), value).toEqual(input);
    }
    for (const value of [...invalidNames, undefined, null, 1, true, [], {}]) {
      expect(parseDesktopLyricOptions(withFont(field, value)), String(value)).toBeUndefined();
    }
  });

  it("数值与枚举 golden", () => {
    const goldens: { field: string; valid: unknown[]; invalid: unknown[] }[] = [
      { field: "size", valid: [20, 24, 96], invalid: [-1, 0, 19, 97] },
      { field: "weight", valid: [100, 200, 700, 900], invalid: [-100, 0, 99, 101, 950, 1000] },
      {
        field: "style",
        valid: ["normal", "italic", "oblique"],
        invalid: ["", "Normal", "bold", "italic "],
      },
    ];
    for (const { field, valid, invalid } of goldens) {
      for (const value of valid) {
        const input = withFont(field, value);
        expect(parseDesktopLyricOptions(input)).toEqual(input);
      }
      for (const value of [...invalid, undefined, null, true, {}, [], NaN, Infinity, 20.5, 100.5]) {
        expect(parseDesktopLyricOptions(withFont(field, value))).toBeUndefined();
      }
    }
    for (const value of ["left", "center", "right", "both"]) {
      const input = { ...createDefaultDesktopLyricOptions(), position: value };
      expect(parseDesktopLyricOptions(input)).toEqual(input);
    }
    for (const value of ["", "Both", "justify", "left ", undefined, null, 1, true]) {
      expect(
        parseDesktopLyricOptions({ ...createDefaultDesktopLyricOptions(), position: value }),
      ).toBeUndefined();
    }
  });

  it.each(booleanFields)("%s 保留布尔值，拒绝隐式转换", (field) => {
    for (const value of [true, false]) {
      const input = { ...createDefaultDesktopLyricOptions(), [field]: value };
      expect(parseDesktopLyricOptions(input)).toEqual(input);
    }
    for (const value of [undefined, null, 0, 1, "false", {}, []]) {
      expect(parseDesktopLyricOptions({ [field]: value })).toBeUndefined();
    }
  });

  it("输入不变，解析结果与输入及其他结果深分离", () => {
    const input = Object.freeze({
      ...createDefaultDesktopLyricOptions(),
      font: Object.freeze({ ...createDefaultDesktopLyricOptions().font, family: "思源黑体" }),
    });
    const first = parseDesktopLyricOptions(input);
    const second = parseDesktopLyricOptions(input);
    expect(first).toEqual(input);
    expect(first).not.toBe(input);
    expect(first?.font).not.toBe(input.font);
    expect(first?.font).not.toBe(second?.font);
    if (!first) throw new Error("有效配置解析失败");
    first.font.family = "Arial";
    first.showYrc = false;
    expect(input.font.family).toBe("思源黑体");
    expect(second?.font.family).toBe("思源黑体");
    const mutable = createDefaultDesktopLyricOptions();
    const copy = parseDesktopLyricOptions(mutable);
    mutable.font.size = 96;
    expect(copy?.font.size).toBe(24);
  });

  it("两层均拒绝异常形状、未知字段、symbol 和访问器且不执行 getter", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const invalidObjects: unknown[] = [
      undefined,
      null,
      true,
      1,
      "{}",
      [],
      new Date(),
      Object.create({}),
      revoked.proxy,
    ];
    for (const key of [
      "unknown",
      "__proto__",
      "constructor",
      "prototype",
      "isLock",
      "playedColor",
      Symbol("extra"),
    ]) {
      invalidObjects.push(Object.defineProperty({}, key, { value: true }));
    }
    let reads = 0;
    for (const key of ["font", "size"]) {
      invalidObjects.push(
        Object.defineProperty({}, key, {
          get() {
            reads++;
            return 24;
          },
        }),
      );
    }
    invalidObjects.push(
      Object.defineProperty({}, "position", {
        set(value: unknown) {
          void value;
        },
      }),
    );
    for (const input of invalidObjects) {
      expect(parseDesktopLyricOptions(input)).toBeUndefined();
      expect(parseDesktopLyricOptions({ font: input })).toBeUndefined();
    }
    expect(reads).toBe(0);
  });
});
