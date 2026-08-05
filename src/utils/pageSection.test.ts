import { describe, expect, it, vi } from "vitest";
import type { AlbumInfo, SongInfo } from "@/types/main.hemusic";
import { PageSectionType, type NormalizedPageSection, type PageSection } from "@/types/page";
import { appendPageSections, normalizePageSections } from "@/utils/pageSection";

const song = (id: string) => ({ id }) as SongInfo;
const album = (id: string) => ({ id }) as AlbumInfo;

const songSection = (overrides: Partial<PageSection> = {}): PageSection => ({
  section_type: PageSectionType.Generic,
  resource_type: "song",
  title: "歌曲",
  songs: [song("song-1")],
  ...overrides,
});

const normalizedSongSection = (
  overrides: Partial<NormalizedPageSection> = {},
): NormalizedPageSection => songSection(overrides) as NormalizedPageSection;

describe("normalizePageSections", () => {
  it("过滤空区块和未知资源类型", () => {
    const warn = vi.fn();
    const sections = normalizePageSections(
      [
        songSection({ songs: [] }),
        songSection({ resource_type: "future-resource" }),
        songSection(),
      ],
      { warn },
    );

    expect(sections).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("将未知区块类型降级为通用区块", () => {
    const warn = vi.fn();
    const [section] = normalizePageSections([songSection({ section_type: 100 })], { warn });

    expect(section.section_type).toBe(PageSectionType.Generic);
    expect(section.resource_type).toBe("song");
    expect(warn).toHaveBeenCalledWith("未知区块类型：100");
  });
});

describe("appendPageSections", () => {
  it("合并分页边界两侧的同资源 FEED", () => {
    const current = [
      normalizedSongSection({
        section_type: PageSectionType.Feed,
        songs: [song("song-1")],
      }),
    ];
    const incoming = [
      normalizedSongSection({
        section_type: PageSectionType.Feed,
        songs: [song("song-2")],
      }),
    ];

    const result = appendPageSections(current, incoming);

    expect(result).toHaveLength(1);
    expect(result[0].songs?.map((item) => item.id)).toEqual(["song-1", "song-2"]);
  });

  it("不同资源类型不合并", () => {
    const current = [normalizedSongSection({ section_type: PageSectionType.Feed })];
    const incoming = [
      {
        section_type: PageSectionType.Feed,
        resource_type: "album",
        title: "专辑",
        albums: [album("album-1")],
      } satisfies NormalizedPageSection,
    ];

    expect(appendPageSections(current, incoming)).toHaveLength(2);
  });

  it("非 FEED 区块不合并", () => {
    const current = [normalizedSongSection()];
    const incoming = [normalizedSongSection()];

    expect(appendPageSections(current, incoming)).toHaveLength(2);
  });

  it("不合并同一页内部相邻 FEED", () => {
    const incoming = [
      normalizedSongSection({ section_type: PageSectionType.Feed }),
      normalizedSongSection({ section_type: PageSectionType.Feed }),
    ];

    expect(appendPageSections([], incoming)).toHaveLength(2);
  });

  it("保留旧标题，并在旧标题为空时采用新标题", () => {
    const titled = appendPageSections(
      [normalizedSongSection({ section_type: PageSectionType.Feed, title: "旧标题" })],
      [normalizedSongSection({ section_type: PageSectionType.Feed, title: "新标题" })],
    );
    const fallback = appendPageSections(
      [normalizedSongSection({ section_type: PageSectionType.Feed, title: "" })],
      [normalizedSongSection({ section_type: PageSectionType.Feed, title: "新标题" })],
    );

    expect(titled[0].title).toBe("旧标题");
    expect(fallback[0].title).toBe("新标题");
  });

  it("追加资源时不去重", () => {
    const result = appendPageSections(
      [
        normalizedSongSection({
          section_type: PageSectionType.Feed,
          songs: [song("same")],
        }),
      ],
      [
        normalizedSongSection({
          section_type: PageSectionType.Feed,
          songs: [song("same")],
        }),
      ],
    );

    expect(result[0].songs).toHaveLength(2);
  });
});
