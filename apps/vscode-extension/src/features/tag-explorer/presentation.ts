import type { NoteView, TagSummary } from '../../types';
import { createInlinePreview } from '../presentation/inlinePreview';

/** Defensively removes duplicate CLI rows and presents tags alphabetically. */
export function prepareTagSummaries(summaries: TagSummary[]): TagSummary[] {
  const unique = new Map<string, TagSummary>();

  for (const summary of summaries) {
    const key = summary.tag.trim().toLowerCase();

    if (key.length > 0 && !unique.has(key)) {
      unique.set(key, summary);
    }
  }

  return [...unique.values()].sort((left, right) =>
    left.tag.localeCompare(right.tag, undefined, { sensitivity: 'base' }),
  );
}

export function prepareTaggedNotes(notes: NoteView[]): NoteView[] {
  return [...notes].sort((left, right) => {
    const fileOrder = left.source_file.localeCompare(right.source_file);

    if (fileOrder !== 0) {
      return fileOrder;
    }

    const lineOrder = noteLine(left) - noteLine(right);

    if (lineOrder !== 0) {
      return lineOrder;
    }

    return left.note.content.localeCompare(right.note.content);
  });
}

export function tagNotePreview(noteView: NoteView): string {
  return createInlinePreview(noteView.note.content, 60);
}

export function tagNoteDescription(noteView: NoteView): string {
  const anchor = noteView.note.anchor;

  if (anchor.type === 'Line') {
    return `${noteView.source_file} · Line ${anchor.line ?? 1}:${anchor.column ?? 1}`;
  }

  const line = noteView.resolved?.line ?? anchor.line_hint;
  const location = typeof line === 'number' ? ` · Line ${line}` : ' · Unresolved';

  return `${noteView.source_file} · Symbol ${anchor.name ?? 'Unknown'}${location}`;
}

function noteLine(noteView: NoteView): number {
  const anchor = noteView.note.anchor;

  if (anchor.type === 'Line') {
    return anchor.line ?? Number.MAX_SAFE_INTEGER;
  }

  return noteView.resolved?.line ?? anchor.line_hint ?? Number.MAX_SAFE_INTEGER;
}
