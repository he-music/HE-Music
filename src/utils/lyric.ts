import { LyricLine, LyricWord } from "@applemusic-like-lyrics/lyric";

export const transSeparator = "[lang:trans]";
export const romaSeparator = "[lang:roma]";

export const splitLocalLyrics = (text: string) => {
  // 获取标签位置（兼容不存在的情况）
  const transIndex = text.indexOf(transSeparator);
  const romaIndex = text.indexOf(romaSeparator);

  // 提取原文（标签之前的内容）
  const lyric = text
    .slice(
      0,
      Math.min(transIndex >= 0 ? transIndex : Infinity, romaIndex >= 0 ? romaIndex : Infinity),
    )
    .trim();

  // 动态提取翻译和罗马音（顺序无关）
  let trans = "",
    roma = "";
  if (transIndex >= 0) {
    const transEnd = text.indexOf(romaSeparator, transIndex + transSeparator.length);
    trans = text
      .slice(
        transIndex + transSeparator.length,
        transEnd >= 0 && transEnd > transIndex ? transEnd : undefined, // 确保结束位置在翻译标签之后
      )
      .trim();
  }
  if (romaIndex >= 0) {
    const romaEnd = text.indexOf(transSeparator, romaIndex + romaSeparator.length);
    roma = text
      .slice(
        romaIndex + romaSeparator.length,
        romaEnd >= 0 && romaEnd > romaIndex ? romaEnd : undefined, // 确保结束位置在罗马音标签之后
      )
      .trim();
  }

  return { lyric, trans, roma };
};

// 处理 AM 歌词
const wordTimestampRegex = /<\d+,\d+>/g;
const wordLineRegex = /<(?<begin>\d+),(?<end>\d+)>(?<word>.*?)(?=<\d+,\d+>|$)/g;

// regexr.com/6e52n
const extractLrcRegex = /^(?<lyricTimestamps>(?:\[.+?\])+)(?!\[)(?<content>.+)$/gm;
const extractTimestampRegex = /\[(?<min>\d+):(?<sec>\d+)(?:\.|:)*(?<ms>\d+)*\]/g;

export const isWordLyric = (lyric: string = "") => wordTimestampRegex.test(lyric);

export const parseLyric = ({ lyric, roma, trans }) => {
  if (!isWordLyric(lyric)) {
    return parseLineLyric({ lyric, roma, trans });
  }
  return parseWordLyric({ lyric, roma, trans });
};

export const parseWordLyric = ({ lyric = "", roma = "", trans = "" }) => {
  const parsedLyrics: LyricLine[] = [];

  const lyrics = parse(lyric);
  const spells = parse(removeWordLyric(roma));
  const transLyrics = parse(removeWordLyric(trans));

  for (const { rawTime, time, content } of lyrics) {
    // content
    // <0,648>Love<648,162> <810,810>Story<1620,162> <1782,162>-<1944,162> <2106,972>Taylor<3078,162> <3240,810>
    const words: LyricWord[] = [];

    wordLineRegex.lastIndex = 0;
    if (!wordLineRegex.test(content)) {
      words.push({
        startTime: time,
        endTime: time,
        word: content,
        romanWord: "",
      });
    } else {
      wordLineRegex.lastIndex = 0;
      for (const line of content.matchAll(wordLineRegex)) {
        if (!line.groups) continue;
        const { begin, end, word } = line.groups as {
          begin: string;
          end: string;
          word: string;
        };
        // console.log("begin:",begin,"end:", end,"word:", word)
        words.push({
          startTime: time + parseInt(begin),
          endTime: time + parseInt(begin) + parseInt(end),
          word: word,
          romanWord: "",
        });
      }
    }

    const lrc: LyricLine = {
      words: words,
      translatedLyric:
        transLyrics.find(({ rawTime: tLyricRawTime }) => tLyricRawTime === rawTime)?.content || "",
      romanLyric:
        spells.find(({ rawTime: sLyricRawTime }) => sLyricRawTime === rawTime)?.content || "",
      startTime: time,
      endTime: words[words.length - 1]?.endTime || time,
      isBG: false,
      isDuet: false,
    };

    if (parsedLyrics[parsedLyrics.length - 1]?.endTime === 0) {
      parsedLyrics[parsedLyrics.length - 1].endTime = time;
    }
    parsedLyrics.push(lrc);
  }

  return { line: parsedLyrics, metadata: {} };
};

export const removeWordLyric = (str: string) => {
  return str.replace(wordTimestampRegex, "");
};

export const parseLineLyric = ({ lyric = "", roma = "", trans = "" }) => {
  const parsedLyrics: LyricLine[] = [];

  const lyrics = parse(removeWordLyric(lyric));
  const spells = parse(removeWordLyric(roma));
  const transLyrics = parse(removeWordLyric(trans));

  for (const { rawTime, time, content } of lyrics) {
    const lrc: LyricLine = {
      words: [
        {
          startTime: time,
          endTime: 0,
          word: content,
          romanWord: "",
        },
      ],
      translatedLyric:
        transLyrics.find(
          ({ rawTime: tRawTime, time: tTime }) => tRawTime === rawTime || tTime === time,
        )?.content || "",
      romanLyric:
        spells.find(({ rawTime: tRawTime, time: tTime }) => tRawTime === rawTime || tTime === time)
          ?.content || "",
      startTime: time,
      endTime: 0,
      isBG: false,
      isDuet: false,
    };

    if (parsedLyrics[parsedLyrics.length - 1]) {
      parsedLyrics[parsedLyrics.length - 1].endTime = time;
      parsedLyrics[parsedLyrics.length - 1].words[0].endTime = time;
    }
    parsedLyrics.push(lrc);
  }
  if (parsedLyrics[parsedLyrics.length - 1]) {
    parsedLyrics[parsedLyrics.length - 1].endTime = Infinity;
    parsedLyrics[parsedLyrics.length - 1].words[0].endTime = Infinity;
  }

  return { line: parsedLyrics, metadata: {} };
};

const trimContent = (content: string) => {
  const t = content.trim();
  return t.length < 1 ? content : t;
};

const parse = (lrc: string) => {
  const parsedLyrics: { rawTime: string; time: number; content: string }[] = [];

  const binarySearch = (lyric) => {
    const time = lyric.time;

    let low = 0;
    let high = parsedLyrics.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midTime = parsedLyrics[mid].time;
      if (midTime === time) {
        low = mid + 1;
      } else if (midTime < time) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return low;
  };

  for (const line of lrc.trim().matchAll(extractLrcRegex)) {
    if (!line.groups) continue;
    const { lyricTimestamps, content } = line.groups as {
      lyricTimestamps: string;
      content: string;
    };

    for (const timestamp of lyricTimestamps.matchAll(extractTimestampRegex)) {
      if (!timestamp.groups) continue;
      const { min, sec, ms } = timestamp.groups as { min: string; sec: string; ms: string };
      const rawTime = timestamp[0];
      const mss = ms?.length == 3 ? ms : ms + "0"; // .02 => .020
      const time = (Number(min) * 60 + Number(sec)) * 1000 + Number(mss ?? 0);

      const parsedLyric = { rawTime, time, content: trimContent(content) };
      parsedLyrics.splice(binarySearch(parsedLyric), 0, parsedLyric);
    }
  }

  return parsedLyrics;
};
