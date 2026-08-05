import {
  PageEntryTargetType,
  PageSectionType,
  type NormalizedPageSection,
  type PageEntry,
  type PageResourceType,
  type PageSection,
  type PageSectionResource,
  type PageSectionTypeValue,
} from "@/types/page";

const resourceFields = {
  song: "songs",
  album: "albums",
  mv: "mvs",
  playlist: "playlists",
  ranking: "rankings",
  radio: "radios",
  artist: "artists",
} as const;

const knownSectionTypes = new Set<number>(Object.values(PageSectionType));
const warnedMessages = new Set<string>();

const specialSectionResources: Partial<Record<PageSectionTypeValue, PageResourceType>> = {
  [PageSectionType.NewSongs]: "song",
  [PageSectionType.NewAlbums]: "album",
  [PageSectionType.Ranking]: "ranking",
};

export type PageSectionResourceField = (typeof resourceFields)[PageResourceType];

export interface NormalizePageSectionOptions {
  warn?: (message: string) => void;
}

const warnOnceInDevelopment = (message: string) => {
  if (!import.meta.env.DEV || warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`[PageSection] ${message}`);
};

export const isPageResourceType = (value: string): value is PageResourceType =>
  Object.hasOwn(resourceFields, value);

export const getPageSectionResourceField = (
  resourceType: PageResourceType,
): PageSectionResourceField => resourceFields[resourceType];

export const getPageSectionResources = (section: NormalizedPageSection): PageSectionResource[] => {
  if (!isPageResourceType(section.resource_type)) return [];
  const field = getPageSectionResourceField(section.resource_type);
  return (section[field] || []) as PageSectionResource[];
};

export const isSupportedPageEntry = (entry: PageEntry): boolean =>
  entry.target_type === PageEntryTargetType.SongList ||
  entry.target_type === PageEntryTargetType.Radio ||
  entry.target_type === PageEntryTargetType.Playlist;

/**
 * 将后端区块收敛为客户端可渲染的数据，并隔离未知枚举和空区块。
 */
export const normalizePageSections = (
  sections: readonly (PageSection | null | undefined)[],
  options: NormalizePageSectionOptions = {},
): NormalizedPageSection[] => {
  const warn = options.warn || warnOnceInDevelopment;
  const normalized: NormalizedPageSection[] = [];

  sections.forEach((section) => {
    if (!section) return;

    // 快捷入口由 target_type 决定行为，协议明确不依赖 resource_type。
    if (section.section_type === PageSectionType.QuickEntries) {
      const entries = Array.isArray(section.entries)
        ? section.entries.filter(isSupportedPageEntry)
        : [];
      if (entries.length === 0) return;

      normalized.push({
        ...section,
        resource_type: section.resource_type,
        title: section.title?.trim() || "",
        entries,
      });
      return;
    }

    if (!isPageResourceType(section.resource_type)) {
      warn(`未知资源类型：${section.resource_type || "(empty)"}`);
      return;
    }

    const field = getPageSectionResourceField(section.resource_type);
    const resources = section[field];
    if (!Array.isArray(resources) || resources.length === 0) return;

    const isKnownSectionType = knownSectionTypes.has(section.section_type);
    const sectionType = isKnownSectionType ? section.section_type : PageSectionType.Generic;
    if (!isKnownSectionType) {
      warn(`未知区块类型：${section.section_type}`);
    }

    const expectedResource = specialSectionResources[sectionType as PageSectionTypeValue];
    if (expectedResource && expectedResource !== section.resource_type) {
      warn(`区块类型 ${sectionType} 预期资源 ${expectedResource}，实际为 ${section.resource_type}`);
    }

    normalized.push({
      ...section,
      section_type: sectionType,
      resource_type: section.resource_type,
      title: section.title?.trim() || "",
    });
  });

  return normalized;
};

/**
 * 只合并分页边界两侧的同资源 FEED；同一响应内部结构保持不变。
 */
export const appendPageSections = (
  current: readonly NormalizedPageSection[],
  incoming: readonly NormalizedPageSection[],
): NormalizedPageSection[] => {
  if (current.length === 0) return [...incoming];
  if (incoming.length === 0) return [...current];

  const lastIndex = current.length - 1;
  const previous = current[lastIndex];
  const next = incoming[0];
  const shouldMerge =
    previous.section_type === PageSectionType.Feed &&
    next.section_type === PageSectionType.Feed &&
    isPageResourceType(previous.resource_type) &&
    isPageResourceType(next.resource_type) &&
    previous.resource_type === next.resource_type;

  if (!shouldMerge) return [...current, ...incoming];

  if (!isPageResourceType(previous.resource_type)) return [...current, ...incoming];
  const field = getPageSectionResourceField(previous.resource_type);
  const previousResources = (previous[field] || []) as PageSectionResource[];
  const nextResources = (next[field] || []) as PageSectionResource[];
  const mergedSection = {
    ...previous,
    title: previous.title || next.title,
    [field]: [...previousResources, ...nextResources],
  } as NormalizedPageSection;

  return [...current.slice(0, lastIndex), mergedSection, ...incoming.slice(1)];
};
