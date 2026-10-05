import type { NoteView } from '../../types';
import { resolveNoteLine as resolvePresentationNoteLine } from '../presentation/editorNoteView';

export interface LineNoteGroup {
  line: number;
  notes: NoteView[];
}

export function resolveNoteLine(note: NoteView): number {
  return resolvePresentationNoteLine(note) ?? Number.NaN;
}

export function sortNotesDeterministic(notes: NoteView[]): NoteView[] {
  return [...notes].sort((left, right) => {
    const kindOrder = anchorKindOrder(left) - anchorKindOrder(right);
    if (kindOrder !== 0) {
      return kindOrder;
    }

    const updatedComparison = compareUpdatedAt(left, right);
    if (updatedComparison !== 0) {
      return updatedComparison;
    }

    return left.note.id.localeCompare(right.note.id);
  });
}

export function aggregateNotesByLine(
  notes: NoteView[],
  lineCount: number,
): LineNoteGroup[] {
  const byLine = new Map<number, NoteView[]>();

  for (const note of notes) {
    const lineNumber = resolvePresentationNoteLine(note);

    if (lineNumber === undefined) {
      continue;
    }

    const line = lineNumber - 1;

    if (line < 0 || line >= lineCount) {
      continue;
    }

    const group = byLine.get(line) ?? [];
    group.push(note);
    byLine.set(line, group);
  }

  return [...byLine.entries()]
    .sort(([leftLine], [rightLine]) => leftLine - rightLine)
    .map(([line, lineNotes]) => ({
      line,
      notes: sortNotesDeterministic(lineNotes),
    }));
}

/** Keeps native VS Code breakpoint glyphs above note gutter markers. */
export function suppressBreakpointLineGroups(
  groups: LineNoteGroup[],
  breakpointLines: ReadonlySet<number>,
): LineNoteGroup[] {
  return groups.filter((group) => !breakpointLines.has(group.line));
}

function anchorKindOrder(note: NoteView): number {
  return note.note.anchor.type === 'Symbol' ? 0 : 1;
}

function compareUpdatedAt(left: NoteView, right: NoteView): number {
  const leftUpdated = left.note.updated_at ?? '';
  const rightUpdated = right.note.updated_at ?? '';

  return rightUpdated.localeCompare(leftUpdated);
}
