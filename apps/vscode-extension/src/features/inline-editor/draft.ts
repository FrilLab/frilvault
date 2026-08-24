/**
 * Draft and validation helpers for the inline note editor UI.
 *
 * inline note editor UI용 draft와 validation helper입니다.
 */
import type { NoteView } from '../../types';

export type InlineEditorMode = 'create' | 'edit';

export interface NoteRevisionSnapshot {
  content: string;
  tags: string[];
  updatedAt?: string;
}

export interface InlineNoteDraft {
  mode: InlineEditorMode;
  workspaceRoot: string;
  sourceFile: string;
  noteId?: string;
  kind: 'Line' | 'Symbol';
  anchorSummary: string;
  line?: number;
  column?: number;
  symbolName?: string;
  symbolKind?: string;
  symbolSignature?: string;
  lineHint?: number;
  content: string;
  tagsText: string;
  expectedUpdatedAt?: string;
  undoSnapshot?: NoteRevisionSnapshot;
}

export interface InlineNoteFormInput {
  content: string;
  tagsText: string;
}

export function validateInlineNoteForm(input: InlineNoteFormInput): string | undefined {
  if (input.content.trim().length === 0) {
    return 'Note content is required.';
  }

  const tags = parseTagsText(input.tagsText);
  if (tags.some((tag) => tag.length === 0)) {
    return 'Tags must not contain empty values.';
  }

  return undefined;
}

export function parseTagsText(tagsText: string): string[] {
  if (tagsText.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();

  return tagsText
    .split(',')
    .map(normalizeTag)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (tag.length === 0 || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).trim();
}

export function formatTagsText(tags: string[] | undefined): string {
  return (tags ?? []).join(', ');
}

export function createEditDraft(
  noteView: NoteView,
  workspaceRoot: string,
): InlineNoteDraft {
  const anchor = noteView.note.anchor;

  if (anchor.type === 'Symbol') {
    return {
      mode: 'edit',
      workspaceRoot,
      sourceFile: noteView.source_file,
      noteId: noteView.note.id,
      kind: 'Symbol',
      anchorSummary: formatSymbolAnchorSummary(noteView),
      symbolName: anchor.name,
      symbolKind: anchor.kind,
      symbolSignature: anchor.signature,
      lineHint: anchor.line_hint,
      content: noteView.note.content,
      tagsText: formatTagsText(noteView.note.tags),
      expectedUpdatedAt: noteView.note.updated_at,
      undoSnapshot: {
        content: noteView.note.content,
        tags: [...(noteView.note.tags ?? [])],
        updatedAt: noteView.note.updated_at,
      },
    };
  }

  return {
    mode: 'edit',
    workspaceRoot,
    sourceFile: noteView.source_file,
    noteId: noteView.note.id,
    kind: 'Line',
    anchorSummary: `Line ${anchor.line ?? 1}:${anchor.column ?? 1}`,
    line: anchor.line ?? 1,
    column: anchor.column ?? 1,
    content: noteView.note.content,
    tagsText: formatTagsText(noteView.note.tags),
    expectedUpdatedAt: noteView.note.updated_at,
    undoSnapshot: {
      content: noteView.note.content,
      tags: [...(noteView.note.tags ?? [])],
      updatedAt: noteView.note.updated_at,
    },
  };
}

export function createLineCreateDraft(input: {
  workspaceRoot: string;
  sourceFile: string;
  line: number;
  column: number;
}): InlineNoteDraft {
  return {
    mode: 'create',
    workspaceRoot: input.workspaceRoot,
    sourceFile: input.sourceFile,
    kind: 'Line',
    anchorSummary: `Line ${input.line}:${input.column}`,
    line: input.line,
    column: input.column,
    content: '',
    tagsText: '',
  };
}

export function createSymbolCreateDraft(input: {
  workspaceRoot: string;
  sourceFile: string;
  symbolName: string;
  symbolKind: string;
  symbolSignature?: string;
  lineHint: number;
}): InlineNoteDraft {
  return {
    mode: 'create',
    workspaceRoot: input.workspaceRoot,
    sourceFile: input.sourceFile,
    kind: 'Symbol',
    anchorSummary: `Symbol ${input.symbolName} (${input.symbolKind}) at line ${input.lineHint}`,
    symbolName: input.symbolName,
    symbolKind: input.symbolKind,
    symbolSignature: input.symbolSignature,
    lineHint: input.lineHint,
    content: '',
    tagsText: '',
  };
}

function formatSymbolAnchorSummary(noteView: NoteView): string {
  const anchor = noteView.note.anchor;
  const resolvedLine = noteView.resolved?.line ?? anchor.line_hint ?? 1;
  const kind = anchor.kind ?? 'Symbol';

  return `Symbol ${anchor.name ?? 'unknown'} (${kind}) at line ${resolvedLine}`;
}

export function applyFormInput(draft: InlineNoteDraft, input: InlineNoteFormInput): InlineNoteDraft {
  return {
    ...draft,
    content: input.content,
    tagsText: input.tagsText,
  };
}

export function revisionFromDraft(draft: InlineNoteDraft): NoteRevisionSnapshot {
  return {
    content: draft.content,
    tags: parseTagsText(draft.tagsText),
    updatedAt: draft.expectedUpdatedAt,
  };
}
