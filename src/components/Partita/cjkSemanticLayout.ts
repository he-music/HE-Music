// Adapted from Folia (chthollyphile), AGPL-3.0: cjkSemanticLayout.ts
// https://github.com/chthollyphile/folia-major

export interface PartitaWordToken {
  text: string;
  startTime: number; // 毫秒
  endTime: number; // 毫秒
}

export interface LyricLayoutUnit {
  text: string;
  words: PartitaWordToken[];
  startTime: number;
  endTime: number;
  isSemantic: boolean;
  isSticky?: boolean;
}

export interface BuildPostLyricLayoutUnitsOptions {
  semantic?: boolean;
  sticky?: boolean;
}

interface WordSegment {
  segment: string;
  isWordLike?: boolean;
}

const CJK_REGEX = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/;
const WHITESPACE_REGEX = /^\s+$/;
const APOSTROPHE_ONLY_REGEX = /^['’]\s*$/;
const CONTRACTION_SUFFIX_REGEX = /^(s|t|m|d|ll|re|ve|em)\s*$/i;
const DIRECT_CONTRACTION_REGEX = /^['’](s|t|m|d|ll|re|ve|em)\s*$/i;
const TRAILING_APOSTROPHE_REGEX = /['’]\s*$/;
const TRAILING_WORD_CHAR_REGEX = /[\p{L}\p{N}]$/u;
const INLINE_CONTRACTION_REGEX = /[\p{L}\p{N}]+['’](s|t|m|d|ll|re|ve|em)/iu;
const STICKY_TRAILING_PUNCTUATION_REGEX = /^[,.;:!?，。！？、：；）】》」』〉〕］)}\]"'’”’]+$/u;

export const hasCjkText = (text: string) => CJK_REGEX.test(text);

export const createSingleWordLayoutUnits = (words: PartitaWordToken[]): LyricLayoutUnit[] =>
  words.map((word) => ({
    text: word.text,
    words: [word],
    startTime: word.startTime,
    endTime: word.endTime,
    isSemantic: false,
  }));

const getWordSegments = (text: string): WordSegment[] | null => {
  if (!text) return null;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
      return Array.from(segmenter.segment(text), (part) => ({
        segment: part.segment,
        isWordLike: part.isWordLike,
      }));
    } catch {
      // 优雅降级
    }
  }
  return null;
};

const cloneUnit = (unit: LyricLayoutUnit): LyricLayoutUnit => ({
  ...unit,
  words: [...unit.words],
});

const appendUnitToStickyUnit = (target: LyricLayoutUnit, unit: LyricLayoutUnit) => {
  target.text += unit.text;
  target.words.push(...unit.words);
  target.endTime = unit.endTime;
  target.isSticky = true;
};

const canAttachToPrevious = (text: string) => TRAILING_WORD_CHAR_REGEX.test(text.trimEnd());
const endsWithApostrophe = (text: string) => TRAILING_APOSTROPHE_REGEX.test(text.trimEnd());
const isApostropheOnlyUnit = (unit: LyricLayoutUnit) =>
  APOSTROPHE_ONLY_REGEX.test(unit.text.trim());
const isContractionSuffixUnit = (unit: LyricLayoutUnit) =>
  CONTRACTION_SUFFIX_REGEX.test(unit.text.trim());
const isDirectContractionUnit = (unit: LyricLayoutUnit) =>
  DIRECT_CONTRACTION_REGEX.test(unit.text.trim());
const isStickyTrailingPunctuationUnit = (unit: LyricLayoutUnit) =>
  STICKY_TRAILING_PUNCTUATION_REGEX.test(unit.text.trim());

const hasAttachedTrailingPunctuation = (unit: LyricLayoutUnit) => {
  if (unit.words.length <= 1) return false;
  const lastWord = unit.words[unit.words.length - 1];
  return Boolean(
    lastWord &&
      isStickyTrailingPunctuationUnit({
        text: lastWord.text,
        words: [lastWord],
        startTime: lastWord.startTime,
        endTime: lastWord.endTime,
        isSemantic: false,
      }),
  );
};

const hasInlineContraction = (unit: LyricLayoutUnit) =>
  unit.words.length > 1 && !unit.isSemantic && INLINE_CONTRACTION_REGEX.test(unit.text);

const appendWordsToUnit = (unit: LyricLayoutUnit, text: string, words: PartitaWordToken[]) => {
  unit.text += text;
  unit.words.push(...words);
  unit.endTime = words[words.length - 1]?.endTime ?? unit.endTime;
};

const mapSegmentsToWords = (
  segments: WordSegment[],
  words: PartitaWordToken[],
): LyricLayoutUnit[] | null => {
  const units: LyricLayoutUnit[] = [];
  let wordIndex = 0;

  for (const segment of segments) {
    const segmentText = segment.segment;
    if (!segmentText || WHITESPACE_REGEX.test(segmentText)) {
      continue;
    }

    const startWordIndex = wordIndex;
    let collectedText = "";

    while (wordIndex < words.length && collectedText.length < segmentText.length) {
      collectedText += words[wordIndex].text;
      wordIndex += 1;

      if (!segmentText.startsWith(collectedText)) {
        return null;
      }
    }

    if (collectedText !== segmentText) {
      return null;
    }

    const segmentWords = words.slice(startWordIndex, wordIndex);
    const firstWord = segmentWords[0];
    const lastWord = segmentWords[segmentWords.length - 1];
    if (!firstWord || !lastWord) {
      return null;
    }

    if (!segment.isWordLike && units.length > 0) {
      appendWordsToUnit(units[units.length - 1], segmentText, segmentWords);
      continue;
    }

    units.push({
      text: segmentText,
      words: segmentWords,
      startTime: firstWord.startTime,
      endTime: lastWord.endTime,
      isSemantic: Boolean(segment.isWordLike && hasCjkText(segmentText) && segmentWords.length > 1),
    });
  }

  if (wordIndex !== words.length || units.length === 0) {
    return null;
  }

  return units;
};

export const buildCjkSemanticLayoutUnits = (
  fullText: string,
  words: PartitaWordToken[],
): LyricLayoutUnit[] => {
  if (words.length === 0) return [];
  const fallbackUnits = createSingleWordLayoutUnits(words);
  if (!hasCjkText(fullText)) return fallbackUnits;

  const segments = getWordSegments(fullText);
  if (!segments) return fallbackUnits;

  return mapSegmentsToWords(segments, words) ?? fallbackUnits;
};

export const applyStickyPunctuationLayoutUnits = (units: LyricLayoutUnit[]): LyricLayoutUnit[] => {
  const merged: LyricLayoutUnit[] = [];

  for (let index = 0; index < units.length; index += 1) {
    const current = units[index];
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(cloneUnit(current));
      continue;
    }

    const next = units[index + 1];
    if (
      isApostropheOnlyUnit(current) &&
      next &&
      canAttachToPrevious(previous.text) &&
      isContractionSuffixUnit(next)
    ) {
      appendUnitToStickyUnit(previous, current);
      appendUnitToStickyUnit(previous, next);
      index += 1;
      continue;
    }

    if (isDirectContractionUnit(current) && canAttachToPrevious(previous.text)) {
      appendUnitToStickyUnit(previous, current);
      continue;
    }

    if (isContractionSuffixUnit(current) && endsWithApostrophe(previous.text)) {
      appendUnitToStickyUnit(previous, current);
      continue;
    }

    if (isStickyTrailingPunctuationUnit(current) && canAttachToPrevious(previous.text)) {
      appendUnitToStickyUnit(previous, current);
      continue;
    }

    merged.push(cloneUnit(current));
  }

  return merged.map((unit) =>
    hasAttachedTrailingPunctuation(unit) || hasInlineContraction(unit)
      ? { ...unit, isSticky: true }
      : unit,
  );
};

export const buildPostLyricLayoutUnits = (
  fullText: string,
  words: PartitaWordToken[],
  options: BuildPostLyricLayoutUnitsOptions = {},
): LyricLayoutUnit[] => {
  const rawUnits = options.semantic
    ? buildCjkSemanticLayoutUnits(fullText, words)
    : createSingleWordLayoutUnits(words);

  return options.sticky ? applyStickyPunctuationLayoutUnits(rawUnits) : rawUnits;
};

export const buildDisplayWordsFromLayoutUnits = (units: LyricLayoutUnit[]): PartitaWordToken[] =>
  units.flatMap((unit) => {
    if (!unit.isSticky || unit.isSemantic) {
      return unit.words;
    }
    return [
      {
        text: unit.text,
        startTime: unit.startTime,
        endTime: unit.endTime,
      },
    ];
  });
