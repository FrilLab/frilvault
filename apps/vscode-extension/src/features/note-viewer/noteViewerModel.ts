import type { NoteView } from '../../types';

export interface NoteViewerItem {
  noteId: string;
  sourceFile: string;
  title: string;
  content: string;
  tags: string[];
  anchorLabel: string;
  anchorLine: number; // 1-based
  anchorKind: 'line' | 'symbol';
  updatedAt?: string;
  priority?: number;
  collapsed: boolean;
}

export interface NoteViewerGroup {
  anchorLine: number; // 1-based
  items: NoteViewerItem[];
  totalCount: number;
}

export function buildNoteViewerItems(notes: NoteView[], defaultState: 'collapsed' | 'expanded'): NoteViewerItem[] {
  const items: NoteViewerItem[] = [];

  for (const view of notes) {
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

    items.push({
      noteId: view.note.id,
      sourceFile: view.source_file,
      title: view.note.title || anchorLabel,
      content: view.note.content,
      tags: view.note.tags ?? [],
      anchorLabel,
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
  const groupsMap = new Map<number, NoteViewerItem[]>();

  for (const item of items) {
    let group = groupsMap.get(item.anchorLine);
    if (!group) {
      group = [];
      groupsMap.set(item.anchorLine, group);
    }
    group.push(item);
  }

  const groups: NoteViewerGroup[] = [];

  for (const [anchorLine, groupItems] of groupsMap.entries()) {
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
      anchorLine,
      items: groupItems,
      totalCount: groupItems.length,
    });
  }

  groups.sort((a, b) => a.anchorLine - b.anchorLine);

  return groups;
}

export function formatCollapsedSummary(group: NoteViewerGroup): string {
  if (group.totalCount === 0) {
    return '▶ Notes (0)';
  }

  if (group.totalCount === 1) {
    const note = group.items[0];
    const lines = note.content.trim().split(/\r?\n/);
    if (lines.length === 1) {
      const truncated = lines[0].length > 40 ? lines[0].substring(0, 40) + '…' : lines[0];
      return `▶ Note · ${truncated}`;
    } else {
      const tags = note.tags.slice(0, 3).map(t => `#${t}`).join(' ');
      const tagsStr = tags ? ` · ${tags}` : '';
      return `▶ Note · ${lines.length} lines${tagsStr}`;
    }
  }

  const allTags = new Set<string>();
  for (const item of group.items) {
    for (const tag of item.tags) {
      allTags.add(tag);
    }
  }

  const combinedTags = Array.from(allTags).slice(0, 3).map((t) => `#${t}`).join(' ');
  const tagsStr = combinedTags ? ` · ${combinedTags}` : '';

  return `▶ Notes (${group.totalCount})${tagsStr}`;
}

export function formatExpandedContent(item: NoteViewerItem, maxPreviewLines: number): string {
  const lines = item.content.split(/\r?\n/);
  if (lines.length <= maxPreviewLines) {
    return item.content;
  }
  return lines.slice(0, maxPreviewLines).join('\n') + '\n…';
}

export function toggleItemCollapsed(items: NoteViewerItem[], noteId: string): NoteViewerItem[] {
  return items.map((item) =>
    item.noteId === noteId ? { ...item, collapsed: !item.collapsed } : item,
  );
}

export function removeItem(items: NoteViewerItem[], noteId: string): NoteViewerItem[] {
  return items.filter((item) => item.noteId !== noteId);
}
