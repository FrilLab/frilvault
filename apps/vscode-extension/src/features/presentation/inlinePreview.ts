/** Normalizes note content for compact display. */
export function normalizeNoteForInlineDisplay(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Creates a truncated one-line preview with a Unicode ellipsis. */
export function createInlinePreview(content: string, maxLength: number): string {
  const normalized = normalizeNoteForInlineDisplay(content);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}
