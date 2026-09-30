import type { NoteAnchor, NoteView } from '../../types';

export interface NoteViewerItem {
  noteId: string;
  sourceFile: string;
  title: string;
  content: string;
  tags: string[];
  anchorLabel: string;
  anchor: NoteAnchor;
  anchorLine: number; // 1-based
  anchorKind: 'line' | 'symbol';
  updatedAt?: string;
  priority?: number;
  collapsed: boolean;
}

export interface NoteViewerGroup {
  anchorLine: number; // 1-based
  anchor: NoteAnchor;
  items: NoteViewerItem[];
  totalCount: number;
}

export function buildNoteViewerItems(notes: NoteView[], defaultState: 'collapsed' | 'expanded'): NoteViewerItem[] {
  const items: NoteViewerItem[] = [];
  const seenNoteIds = new Set<string>();

  for (const view of notes) {
    if (seenNoteIds.has(view.note.id)) {
      continue;
    }

    const isSymbol = view.note.anchor.type === 'Symbol';

    let anchorLine: number | undefined;
    let anchorLabel = '';

    if (isSymbol) {
      if (!view.resolved) {
        continue;
      }
      anchorLine = view.resolved.line;
      anchorLabel = `Symbol: ${view.note.anchor.name ?? 'unknown'}`;
    } else {
      anchorLine = view.note.anchor.line ?? 1;
      anchorLabel = `Line ${anchorLine}`;
    }

    if (anchorLine === undefined) {
      continue;
    }

    seenNoteIds.add(view.note.id);

    items.push({
      noteId: view.note.id,
      sourceFile: view.source_file,
      title: view.note.title || anchorLabel,
      content: view.note.content,
      tags: normalizeTags(view.note.tags ?? []),
      anchorLabel,
      anchor: { ...view.note.anchor },
      anchorLine,
      anchorKind: isSymbol ? 'symbol' : 'line',
      updatedAt: view.note.updated_at,
      priority: view.note.priority,
      collapsed: defaultState === 'collapsed',
    });
  }

  return items;
}

export function groupNoteViewerItems(items: NoteViewerItem[]): NoteViewerGroup[] {
  const groupsMap = new Map<string, NoteViewerItem[]>();

  for (const item of items) {
    const key = noteAnchorKey(item.anchor);
    let group = groupsMap.get(key);
    if (!group) {
      group = [];
      groupsMap.set(key, group);
    }
    group.push(item);
  }

  const groups: NoteViewerGroup[] = [];

  for (const groupItems of groupsMap.values()) {
    groupItems.sort((a, b) => {
      const priorityA = a.priority ?? 0;
      const priorityB = b.priority ?? 0;
      if (priorityA !== priorityB) {
        return priorityB - priorityA; // desc
      }

      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (timeA !== timeB) {
        return timeB - timeA; // desc
      }

      return a.noteId.localeCompare(b.noteId);
    });

    groups.push({
      anchorLine: groupItems[0].anchorLine,
      anchor: groupItems[0].anchor,
      items: groupItems,
      totalCount: groupItems.length,
    });
  }

  groups.sort((a, b) => {
    const lineDifference = a.anchorLine - b.anchorLine;
    return lineDifference || noteAnchorKey(a.anchor).localeCompare(noteAnchorKey(b.anchor));
  });

  return groups;
}

export function formatCollapsedSummary(group: NoteViewerGroup): string {
  return '▶';
}

export function formatExpandedPreview(group: NoteViewerGroup, maxLength = 88): string {
  const previews = group.items
    .map((item) => firstNonEmptyLogicalLine(item.content, maxLength))
    .filter(Boolean);
  const preview = previews.join(' · ');
  return preview.length > maxLength
    ? `${Array.from(preview).slice(0, maxLength - 1).join('').trimEnd()}…`
    : preview;
}

export function firstNonEmptyLogicalLine(content: string, maxLength = 88): string {
  const firstLine = content.split(/\r\n|\n|\r/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return '';
  }

  const characters = Array.from(firstLine);
  return characters.length <= maxLength
    ? firstLine
    : `${characters.slice(0, Math.max(0, maxLength - 1)).join('').trimEnd()}…`;
}

export function formatGroupTags(group: NoteViewerGroup, maxTags = 3): string[] {
  const tags = normalizeTags(group.items.flatMap((item) => item.tags));
  const visible = tags.slice(0, maxTags).map((tag) => `#${tag}`);
  if (tags.length > maxTags) {
    visible.push(`+${tags.length - maxTags}`);
  }
  return visible;
}

export function noteAnchorKey(anchor: NoteAnchor): string {
  if (anchor.type === 'Line') {
    return JSON.stringify(['Line', anchor.line ?? 1, anchor.column ?? 1]);
  }

  return JSON.stringify([
    'Symbol',
    anchor.name ?? '',
    (anchor.kind ?? 'unknown').toLocaleLowerCase(),
    anchor.signature ?? '',
  ]);
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const tag of tags) {
    const value = tag.trim().replace(/^#+/, '');
    const key = value.toLocaleLowerCase();

    if (!value || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(value);
  }

  return normalized;
}
