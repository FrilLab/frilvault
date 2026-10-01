import type { NoteView, TagSummary } from '../../types';
import { createInlinePreview } from '../presentation/inlinePreview';
import * as path from 'node:path';

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

  const line = noteView.resolved?.line;
  const location = typeof line === 'number' ? ` · Line ${line}` : ' · Unresolved';

  return `${noteView.source_file} · Symbol ${anchor.name ?? 'Unknown'}${location}`;
}

export function tagNoteLabel(
  noteView: NoteView,
  fileIdentity: string,
  tag: string,
): string {
  const anchor = noteView.note.anchor;
  const line = anchor.type === 'Line'
    ? anchor.line ?? 1
    : noteView.resolved?.line;
  const location = typeof line === 'number' ? `L${line}` : `Unresolved · ${fileIdentity}`;
  const file = typeof line === 'number' ? fileIdentity : undefined;
  const preview = tagNotePreview(noteView);
  const tagSuffix = tag.trim() ? ` · ${tag.trim().replace(/^#+/, '')}` : '';
  const label = file
    ? `${location} · ${file}${tagSuffix}`
    : `${location}${tagSuffix}`;

  return preview ? `${label} — ${preview}` : label;
}

export function tagFileIdentities(notes: NoteView[]): Map<string, string> {
  const paths = [...new Set(notes.map((note) => normalizeSourcePath(note.source_file)))];
  const basenames = new Map<string, string[]>();

  for (const sourceFile of paths) {
    const basename = path.posix.basename(sourceFile);
    const values = basenames.get(basename) ?? [];
    values.push(sourceFile);
    basenames.set(basename, values);
  }

  const result = new Map<string, string>();
  for (const sourceFile of paths) {
    const segments = sourceFile.split('/');
    const basename = segments.at(-1) ?? sourceFile;
    const siblings = basenames.get(basename) ?? [];
    if (siblings.length <= 1) {
      result.set(sourceFile, basename);
      continue;
    }

    let suffixLength = 2;
    let suffix = segments.slice(-suffixLength).join('/');
    while (suffixLength < segments.length && siblings.some((candidate) => {
      const candidateSuffix = candidate.split('/').slice(-suffixLength).join('/');
      return candidate !== sourceFile && candidateSuffix === suffix;
    })) {
      suffixLength += 1;
      suffix = segments.slice(-suffixLength).join('/');
    }
    result.set(sourceFile, suffix);
  }

  return result;
}

function normalizeSourcePath(sourceFile: string): string {
  return sourceFile.replaceAll('\\', '/').replace(/^\.\//, '');
}

function noteLine(noteView: NoteView): number {
  const anchor = noteView.note.anchor;

  if (anchor.type === 'Line') {
    return anchor.line ?? Number.MAX_SAFE_INTEGER;
  }

  return noteView.resolved?.line ?? anchor.line_hint ?? Number.MAX_SAFE_INTEGER;
}
