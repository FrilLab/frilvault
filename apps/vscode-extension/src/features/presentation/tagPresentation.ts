export const HOVER_TAG_LIMIT = 8;
export const SIDEBAR_TAG_LIMIT = 3;

export interface PresentedTags {
  tags: string[];
  hiddenCount: number;
}

/** Normalizes stored tag values for display without changing note data. */
export function presentTags(tags: string[] | undefined, limit = Number.POSITIVE_INFINITY): PresentedTags {
  const normalized = (tags ?? [])
    .map((tag) => tag.trim().replace(/^#/, '').trim())
    .filter((tag) => tag.length > 0);
  const visibleCount = Math.max(0, Math.floor(limit));

  return {
    tags: normalized.slice(0, visibleCount),
    hiddenCount: Math.max(0, normalized.length - visibleCount),
  };
}

export function formatTag(tag: string): string {
  const normalized = tag.trim().replace(/^#/, '').trim();
  return normalized.length > 0 ? `#${normalized}` : '';
}

export function formatTagList(
  tags: string[] | undefined,
  limit = Number.POSITIVE_INFINITY,
): string | undefined {
  const presented = presentTags(tags, limit);

  if (presented.tags.length === 0) {
    return undefined;
  }

  const labels = presented.tags.map(formatTag);

  if (presented.hiddenCount > 0) {
    labels.push(`+${presented.hiddenCount} more`);
  }

  return labels.join('  ');
}
