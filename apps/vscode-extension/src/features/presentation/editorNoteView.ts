import * as vscode from 'vscode';

import type { NoteView } from '../../types';
import { buildNoteUri } from '../decorations/gutterActions';

export type ResolutionStatus = 'resolved' | 'stale' | 'unresolved';

export type ResolvedNoteAnchor =
  | {
      kind: 'symbol';
      symbolName: string;
      symbolKind?: string;
      resolvedRange?: vscode.Range;
      resolutionStatus: ResolutionStatus;
    }
  | {
      kind: 'line';
      line: number;
      column?: number;
      resolvedRange: vscode.Range;
    };

export interface EditorNoteView {
  noteId: string;
  sourceFile: string;
  content: string;
  noteType?: string;
  tags: string[];
  priority?: number;
  updatedAt?: string;
  decisionMetadata?: string;
  anchor: ResolvedNoteAnchor;
  stableUri: string;
}

/** Converts a CLI note view into the shared editor presentation model. */
export function toEditorNoteView(note: NoteView, workspaceRoot: string): EditorNoteView {
  return {
    noteId: note.note.id,
    sourceFile: note.source_file,
    content: note.note.content,
    noteType: inferNoteType(note),
    tags: note.note.tags ?? [],
    priority: note.note.priority,
    updatedAt: note.note.updated_at,
    decisionMetadata: note.note.decision_metadata,
    anchor: resolveNoteAnchor(note),
    stableUri: buildNoteUri(note.note.id, workspaceRoot),
  };
}

/** Returns the 1-based line used for gutter aggregation, or undefined for unresolved symbols. */
export function resolveNoteLine(note: NoteView): number | undefined {
  if (note.note.anchor.type === 'Line') {
    return note.note.anchor.line ?? 1;
  }

  if (!note.resolved) {
    return undefined;
  }

  return note.resolved.line;
}

export function resolveNoteRange(note: NoteView, lineCount: number): vscode.Range | undefined {
  if (note.note.anchor.type === 'Line') {
    const line = Math.max((note.note.anchor.line ?? 1) - 1, 0);

    if (line >= lineCount) {
      return undefined;
    }

    const column = Math.max((note.note.anchor.column ?? 1) - 1, 0);

    return new vscode.Range(line, column, line, column);
  }

  if (!note.resolved) {
    return undefined;
  }

  const line = Math.max(note.resolved.line - 1, 0);

  if (line >= lineCount) {
    return undefined;
  }

  const column = Math.max(note.resolved.column - 1, 0);

  return new vscode.Range(line, column, line, column);
}

export function formatNoteTitle(view: EditorNoteView): string | undefined {
  return view.noteType;
}

export function formatAnchorLabel(anchor: ResolvedNoteAnchor): string {
  if (anchor.kind === 'line') {
    const columnSuffix =
      typeof anchor.column === 'number' ? `:${anchor.column}` : '';

    return `Line ${anchor.line}${columnSuffix}`;
  }

  return `Symbol: ${anchor.symbolName}`;
}

export function formatAnchorHeading(anchor: ResolvedNoteAnchor): string {
  return formatAnchorLabel(anchor);
}

export function formatAnchorDetail(_anchor: ResolvedNoteAnchor): string | undefined {
  return undefined;
}

export function formatResolutionWarning(anchor: ResolvedNoteAnchor): string | undefined {
  if (anchor.kind !== 'symbol' || anchor.resolutionStatus !== 'unresolved') {
    return undefined;
  }

  return 'Could not resolve the current declaration.';
}

export {
  createInlinePreview,
  formatInlineNotesPreview,
  normalizeInlineContent,
  normalizeNoteForInlineDisplay,
  truncateInlineContent,
} from './inlinePreview';

function resolveNoteAnchor(note: NoteView): ResolvedNoteAnchor {
  if (note.note.anchor.type === 'Line') {
    const line = note.note.anchor.line ?? 1;
    const column = note.note.anchor.column ?? 1;

    return {
      kind: 'line',
      line,
      column,
      resolvedRange: new vscode.Range(line - 1, column - 1, line - 1, column - 1),
    };
  }

  const symbolName = note.note.anchor.name ?? 'Symbol';
  const resolutionStatus: ResolutionStatus = note.resolved ? 'resolved' : 'unresolved';
  const resolvedRange = note.resolved
    ? new vscode.Range(
        note.resolved.line - 1,
        note.resolved.column - 1,
        note.resolved.line - 1,
        note.resolved.column - 1,
      )
    : undefined;

  return {
    kind: 'symbol',
    symbolName,
    symbolKind: note.note.anchor.kind,
    resolvedRange,
    resolutionStatus,
  };
}

function inferNoteType(note: NoteView): string | undefined {
  if (note.note.title?.trim()) {
    return note.note.title.trim();
  }

  return undefined;
}
