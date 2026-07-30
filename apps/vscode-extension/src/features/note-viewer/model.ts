import type { NoteView } from '../../types';
import { deduplicateNotesById } from '../presentation/deduplicateNotes';
import { resolveNoteLine } from '../presentation/editorNoteView';
import { sortNotesDeterministic } from '../decorations/aggregate';

export interface NoteViewerGroup {
  id: string;
  line: number;
  notes: NoteView[];
  lineCount: number;
  summaryTags: string[];
}

export interface NoteViewerBlock {
  group: NoteViewerGroup;
  expanded: boolean;
  collapsedText: string;
  expandedText: string;
}

export interface NoteViewerModelOptions {
  defaultExpanded: boolean;
  isExpanded: (groupId: string) => boolean;
  maxPreviewLines: number;
}

export function buildNoteViewerModel(
  notes: NoteView[],
  lineCount: number,
  options: NoteViewerModelOptions,
): NoteViewerBlock[] {
  return groupNotesForViewer(notes, lineCount).map((group) => {
    const expanded = options.isExpanded(group.id) || options.defaultExpanded;

    return {
      group,
      expanded,
      collapsedText: formatCollapsedBlock(group, options.maxPreviewLines),
      expandedText: formatExpandedBlock(group),
    };
  });
}

export function groupNotesForViewer(
  notes: NoteView[],
  lineCount: number,
): NoteViewerGroup[] {
  const groups = new Map<number, NoteView[]>();

  for (const note of sortNotesDeterministic(deduplicateNotesById(notes))) {
    const resolvedLine = resolveNoteLine(note);

    if (resolvedLine === undefined) {
      continue;
    }

    const zeroBasedLine = resolvedLine - 1;

    if (zeroBasedLine < 0 || zeroBasedLine >= lineCount) {
      continue;
    }

    const group = groups.get(zeroBasedLine) ?? [];
    group.push(note);
    groups.set(zeroBasedLine, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, groupedNotes]) => {
      const ids = groupedNotes.map((note) => note.note.id).sort();
      return {
        id: `${line}:${ids.join(',')}`,
        line,
        notes: groupedNotes,
        lineCount: groupedNotes.reduce((sum, note) => sum + countContentLines(note.note.content), 0),
        summaryTags: collectSummaryTags(groupedNotes),
      };
    });
}

function formatCollapsedBlock(group: NoteViewerGroup, maxPreviewLines: number): string {
  const prefix = group.notes.length === 1 ? '> Note' : `> Notes (${group.notes.length})`;
  const lineLabel = `${Math.min(group.lineCount, maxPreviewLines)}`
    + `${group.lineCount > maxPreviewLines ? '+' : ''} lines`;
  const tags = group.summaryTags.length > 0 ? ` · ${group.summaryTags.join(' ')}` : '';

  return `${prefix} · ${lineLabel}${tags}`;
}

function formatExpandedBlock(group: NoteViewerGroup): string {
  const lines = [group.notes.length === 1 ? 'v Note' : `v Notes (${group.notes.length})`, ''];

  if (group.notes.length === 1) {
    lines.push(...formatSingleNote(group.notes[0]));
  } else {
    group.notes.forEach((note, index) => {
      if (index > 0) {
        lines.push('');
      }

      lines.push(`[${index + 1}] ${noteLabel(note)}`);
      lines.push(...indentLines(contentLines(note.note.content)));
    });
  }

  const tags = collectAllTags(group.notes);
  if (tags.length > 0) {
    lines.push('', tags.join(' '));
  }

  return lines.join('\n');
}

function formatSingleNote(note: NoteView): string[] {
  const lines = contentLines(note.note.content);
  const tags = collectAllTags([note]);

  if (tags.length > 0) {
    return [...lines, '', ...[tags.join(' ')]];
  }

  return lines;
}

function noteLabel(note: NoteView): string {
  const title = note.note.title?.trim();

  if (title) {
    return title;
  }

  const firstLine = contentLines(note.note.content)[0] ?? '(empty note)';
  return firstLine.length > 48 ? `${firstLine.slice(0, 48).trimEnd()}...` : firstLine;
}

function indentLines(lines: string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

function contentLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  return lines.length === 1 && lines[0] === '' ? ['(empty note)'] : lines.map((line) => line || '');
}

function countContentLines(content: string): number {
  return Math.max(content.replace(/\r\n/g, '\n').split('\n').length, 1);
}

function collectSummaryTags(notes: NoteView[]): string[] {
  return collectAllTags(notes).slice(0, 3);
}

function collectAllTags(notes: NoteView[]): string[] {
  const seen = new Set<string>();

  for (const note of notes) {
    for (const tag of note.note.tags ?? []) {
      const normalized = normalizeTag(tag);

      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
    }
  }

  return [...seen];
}

function normalizeTag(tag: string): string | undefined {
  const trimmed = tag.trim().replace(/^#+/, '');

  if (!trimmed) {
    return undefined;
  }

  return `#${trimmed}`;
}
