import { describe, expect, it } from "vitest";
import { createChapterTitleComparator, sortChapterItems } from "./chapterSort";

const sort = (titles: readonly string[], ascending = true) =>
  sortChapterItems(titles, (title) => title, ascending);

function expectOrder(titles: string[]) {
  expect(sort([...titles].reverse())).toEqual(titles);
  expect(sort(titles, false)).toEqual([...titles].reverse());
}

describe("chapterSort", () => {
  it("按季、章节的数值排序，并将前传放在第一季之前、最终季放在最后", () => {
    expectOrder([
      "作品 前传",
      "作品 第一季 第2集",
      "作品 第一季 第十集",
      "作品 第二部 第1话",
      "作品 第100000季 第1章",
      "作品 最终季 第1节",
      "作品 最终季 第2回",
    ]);
  });

  it("同一季的正片小于特别篇，特别篇小于大结局，不使用有限哨兵", () => {
    expectOrder([
      "作品 第1集",
      "作品 第99999999999999999999999999999999999集",
      "作品 特别篇 第1集",
      "作品 特别篇 第2集",
      "作品 大结局",
    ]);
  });

  it.each(["番外", "SP", "OVA", "特別篇"])("识别特别篇标记 %s", (marker) => {
    expectOrder(["作品 第10000集", `作品 ${marker}`, "作品 大结局"]);
  });

  it("最终季编号章节中的大结局仍在特别篇之后", () => {
    expectOrder(["作品 最终季 第1集", "作品 最终季 SP", "作品 最终季 第2集 大结局"]);
  });

  it("解析中文位值、逐位数字、零、两及万亿", () => {
    expectOrder([
      "作品 第零集",
      "作品 第两集",
      "作品 第十一集",
      "作品 第〇一二集",
      "作品 第二十一集",
      "作品 第一百零二集",
      "作品 第一千零一集",
      "作品 第一万零一集",
      "作品 第十万集",
      "作品 第一亿二千万集",
    ]);
  });

  it("解析全角阿拉伯数字和大小写 Unicode 罗马数字", () => {
    expectOrder([
      "作品 第１季 第２集",
      "作品 第Ⅰ季 第ⅲ集",
      "作品 第I季 第Ⅳ集",
      "作品 第１季 第１０集",
      "作品 第Ⅱ季 第1集",
      "作品 第Ⅹ季 第1集",
    ]);
  });

  it("不同作品先按原拼音比较作品名，不让季号抢序", () => {
    const groups = ["阿城", "北京", "重庆"].sort(new Intl.Collator("zh-CN").compare);
    expectOrder(
      groups.flatMap((group) => [
        `${group} 第2季 第1集`,
        `${group} 第100季 第1集`,
        `${group} 最终季 第1集`,
      ]),
    );
  });

  it("仅有一个明确编号季时，将缺失季号的章节和特别篇归入该季", () => {
    expectOrder([
      "作品 序章",
      "作品 第三季 第1集",
      "作品 第2集",
      "作品 第三季 第10集",
      "作品 番外",
      "作品 第三季 大结局",
    ]);
  });

  it("多季作品的无季号内容在编号季之后、最终季之前", () => {
    expectOrder([
      "作品 第1季 第1集",
      "作品 第2季 第1集",
      "作品 第3集",
      "作品 特别篇",
      "作品 大结局",
      "作品 最终季 第1集",
    ]);
  });

  it("同章节按上中下排序", () => {
    expectOrder(["作品 第1集 上", "作品 第1集 中", "作品 第1集 下", "作品 第2集"]);
  });

  it("普通标题保留原有拼音排序，不推断无标记数字和四季歌", () => {
    const titles = [
      "四季歌",
      "第一个清晨",
      "1999",
      "10首歌",
      "2首歌",
      "十年",
      "爱你",
      "SPARK",
      "番外的故事",
    ];
    const compare = new Intl.Collator("zh-CN").compare;
    expect(sort(titles)).toEqual([...titles].sort(compare));
    expect(sort(titles, false)).toEqual([...titles].sort((a, b) => -compare(a, b)));
  });

  it("等价章节键保留输入次序，降序也不反转同键条目", () => {
    const source = [
      { id: 1, name: "作品 第2集 标题甲" },
      { id: 2, name: "作品 第二集 标题乙" },
      { id: 3, name: "作品 第1集" },
    ];
    const snapshot = [...source];
    expect(sortChapterItems(source, (item) => item.name, true).map((item) => item.id)).toEqual([
      3, 1, 2,
    ]);
    expect(sortChapterItems(source, (item) => item.name, false).map((item) => item.id)).toEqual([
      1, 2, 3,
    ]);
    expect(source).toEqual(snapshot);
  });

  it("混合普通标题和章节的比较器满足反对称、传递及确定性", () => {
    const titles = [
      "作品 第2集",
      "作品 第10集",
      "作品 第十一集",
      "作品 第四集",
      "作品",
      "作品 第3集 原声",
      "作品集",
      "作品 特别篇",
      "作品 大结局",
      "阿城 第100季 第999999集",
      "阿城 最终季 第1集",
      "阿城 第1季 序章",
      "阿城 前传",
      "阿城 第3集",
      "阿城 SP",
      "四季歌",
      "1999",
      "爱你",
      "北京 第Ⅰ季 第２集",
      "北京 第1季 第二集",
      "北京 第2季 第1集",
    ];
    const compare = createChapterTitleComparator(titles);
    const compareReversed = createChapterTitleComparator([...titles].reverse());
    for (const a of titles) {
      expect(compare(a, a)).toBe(0);
      for (const b of titles) {
        expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0);
        expect(compare(a, b)).toBe(compareReversed(a, b));
        for (const c of titles) {
          if (compare(a, b) <= 0 && compare(b, c) <= 0) {
            expect(compare(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it("空列表和单条保持不变", () => {
    expect(sort([])).toEqual([]);
    expect(sort(["作品 第一集"])).toEqual(["作品 第一集"]);
  });
});
