const collator = new Intl.Collator("zh-CN");
const numeral = "[0-9零〇一二两兩三四五六七八九十百千万萬亿億]+|[IVXLCDM]+";
const seasonPattern = new RegExp(`第\\s*(${numeral})\\s*[季部]`, "i");
const chapterPattern = new RegExp(`第\\s*(${numeral})\\s*[集话話章节節回]`, "i");
const markerEnd = "(?=$|[\\s:：,，。!！?？()（）\\[\\]【】《》_\\-]|第)";
const finalSeasonPattern = /(?:第\s*)?(?:最终季|最終季|最后一季|最後一季|末季|完结季|完結季)/;
const prologuePattern = new RegExp(`(?:前传|前傳|序章|序幕)${markerEnd}`);
const specialPattern = new RegExp(`(?:特别篇|特別篇|番外)${markerEnd}|\\b(?:SP|OVA)\\b`, "i");
const finalePattern = new RegExp(
  `(?:大结局|大結局|最终集|最終集|最终话|最終話|最后一集|最後一集|最后一话|最後一話|完结篇|完結篇)${markerEnd}`,
);
const groupEdges = /^[\s:：,，。()（）[\]【】《》_-]+|[\s:：,，。()（）[\]【】《》_-]+$/g;
const partPattern = /^[\s(（[【:：_-]*(上|中|下)(?:集|篇|部分)?(?=$|[\s)）\]】:：_-])/;
const chineseDigits: Readonly<Record<string, bigint>> = {
  零: 0n,
  〇: 0n,
  一: 1n,
  二: 2n,
  两: 2n,
  兩: 2n,
  三: 3n,
  四: 4n,
  五: 5n,
  六: 6n,
  七: 7n,
  八: 8n,
  九: 9n,
};
const chineseUnits: Readonly<Record<string, bigint>> = { 十: 10n, 百: 100n, 千: 1000n };
const romanValues: Readonly<Record<string, bigint>> = {
  I: 1n,
  V: 5n,
  X: 10n,
  L: 50n,
  C: 100n,
  D: 500n,
  M: 1000n,
};

function parseNumber(raw: string): bigint | null {
  if (/^[0-9]+$/.test(raw)) return BigInt(raw);
  const roman = raw.toUpperCase();
  if (/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(roman)) {
    let result = 0n;
    let previous = 0n;
    for (const character of [...roman].reverse()) {
      const value = romanValues[character];
      result += value < previous ? -value : value;
      previous = value;
    }
    return result;
  }
  if (!/[十百千万萬亿億]/.test(raw)) {
    const digits = [...raw].map((character) => chineseDigits[character]);
    return digits.some((digit) => digit === undefined) ? null : BigInt(digits.join(""));
  }
  let total = 0n;
  let section = 0n;
  let digit: bigint | null = null;
  let previousUnit = 10000n;
  for (const character of raw) {
    const value = chineseDigits[character];
    if (value !== undefined) {
      if (digit !== null && digit !== 0n) return null;
      digit = value;
      continue;
    }
    if (/[万萬亿億]/.test(character)) {
      section += digit ?? 0n;
      if (section === 0n) return null;
      if (/[亿億]/.test(character)) {
        total = (total + section) * 100000000n;
      } else {
        total += section * 10000n;
      }
      section = 0n;
      digit = null;
      previousUnit = 10000n;
      continue;
    }
    const unit = chineseUnits[character];
    if (unit === undefined || unit >= previousUnit || digit === 0n) return null;
    if (digit === null && !(unit === 10n && section === 0n)) return null;
    section += (digit ?? 1n) * unit;
    previousUnit = unit;
    digit = null;
  }
  return total + section + (digit ?? 0n);
}

interface ChapterTitle {
  group: string;
  season: bigint | null;
  finalSeason: boolean;
  chapter: bigint | null;
  // 标题、前传、正片、特别篇、大结局依次排列；不使用有限数字模拟无穷大。
  kind: number;
  part: number;
}

function parseChapterTitle(title: string): ChapterTitle | null {
  const text = title.replace(/[\uff01-\uff5e\u3000\u2160-\u217f]/g, (value) =>
    value.normalize("NFKC"),
  );
  const season = seasonPattern.exec(text);
  const chapter = chapterPattern.exec(text);
  const finalSeason = finalSeasonPattern.exec(text);
  const prologue = prologuePattern.exec(text);
  const special = specialPattern.exec(text);
  const finale = finalePattern.exec(text);
  const seasonNumber = season ? parseNumber(season[1]) : null;
  const chapterNumber = chapter ? parseNumber(chapter[1]) : null;
  if ((season && seasonNumber === null) || (chapter && chapterNumber === null)) return null;
  const markers = [season, chapter, finalSeason, prologue, special, finale].filter(
    (match) => match !== null,
  );
  if (!markers.length) return null;
  const start = Math.min(...markers.map((match) => match.index));
  const part = chapter ? partPattern.exec(text.slice(chapter.index + chapter[0].length)) : null;
  return {
    group: text.slice(0, start).replace(groupEdges, "").toLowerCase(),
    season: seasonNumber,
    finalSeason: finalSeason !== null,
    chapter: chapterNumber,
    kind: finale ? 4 : special ? 3 : prologue ? 1 : chapter ? 2 : 0,
    part: part?.[1] === "上" ? 1 : part?.[1] === "中" ? 2 : part?.[1] === "下" ? 3 : 0,
  };
}

const compareNumber = (left: bigint | number, right: bigint | number): number =>
  left < right ? -1 : left > right ? 1 : 0;

type CompareText = (left: string, right: string) => number;

/** 为整个列表准备固定排序键，避免仅在两个标题都命中时回退而产生比较循环。 */
export function createChapterTitleComparator(
  titles: readonly string[],
  compareText: CompareText = collator.compare,
): CompareText {
  const parsed = new Map(titles.map((title) => [title, parseChapterTitle(title)]));
  const seasons = new Map<string, Set<bigint>>();
  const finalGroups = new Set<string>();
  for (const key of parsed.values()) {
    if (!key) continue;
    if (key.finalSeason) finalGroups.add(key.group);
    if (key.season !== null) {
      const groupSeasons = seasons.get(key.group) ?? new Set<bigint>();
      groupSeasons.add(key.season);
      seasons.set(key.group, groupSeasons);
    }
  }
  const prepare = (title: string) => {
    const key = parsed.get(title);
    if (!key) return { group: title, rank: 0, season: 0n, kind: 0, chapter: 0n, part: 0 };
    const groupSeasons = seasons.get(key.group);
    const inferred =
      groupSeasons?.size === 1 && !finalGroups.has(key.group)
        ? groupSeasons.values().next().value
        : undefined;
    const season = key.season ?? (key.finalSeason ? undefined : inferred);
    // 无季号的前传在第一季前；多季作品的无季号内容在编号季之后、最终季之前。
    const rank = key.finalSeason
      ? 3
      : key.season === null && key.kind === 1
        ? -1
        : season !== undefined
          ? 0
          : groupSeasons || finalGroups.has(key.group)
            ? 2
            : 0;
    return {
      group: key.group,
      rank,
      season: season ?? 0n,
      kind: key.kind,
      chapter: key.chapter ?? 0n,
      part: key.part,
    };
  };
  const keys = new Map(titles.map((title) => [title, prepare(title)]));
  return (left, right) => {
    const a = keys.get(left) ?? prepare(left);
    const b = keys.get(right) ?? prepare(right);
    return (
      compareText(a.group, b.group) ||
      compareNumber(a.rank, b.rank) ||
      compareNumber(a.season, b.season) ||
      compareNumber(a.kind, b.kind) ||
      compareNumber(a.chapter, b.chapter) ||
      compareNumber(a.part, b.part)
    );
  };
}

/** 同键保留源顺序；升降序只反转排序键，不反转原始索引。 */
export function sortChapterItems<T>(
  source: readonly T[],
  titleOf: (item: T) => string,
  ascending: boolean,
  compareText: CompareText = collator.compare,
): T[] {
  const entries = source.map((item, index) => ({ item, index, title: titleOf(item) }));
  const compare = createChapterTitleComparator(
    entries.map((entry) => entry.title),
    compareText,
  );
  return entries
    .sort((a, b) => {
      const result = compare(a.title, b.title);
      return (ascending ? result : -result) || a.index - b.index;
    })
    .map((entry) => entry.item);
}
