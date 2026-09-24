/**
 * Persists inline editor drafts through the CLI/Core boundary.
 *
 * inline editor draft를 CLI/Core 경계를 통해 저장합니다.
 */
import type { CliClient } from '../../core/cliClient';
import type { NoteView } from '../../types';
import {
  createLineCreateDraft,
  createSymbolCreateDraft,
  parseTagsText,
  type InlineNoteDraft,
  type NoteRevisionSnapshot,
} from './draft';

export class InlineNoteEditorService {
  public constructor(private readonly cliClient: CliClient) {}

  public async saveDraft(draft: InlineNoteDraft): Promise<NoteView> {
    const tags = parseTagsText(draft.tagsText);

    if (draft.mode === 'create') {
      if (draft.kind === 'Symbol') {
        if (!draft.symbolName) {
          throw new Error('Symbol note is missing a symbol name.');
        }

        return this.cliClient.addSymbolNote({
          workspaceRoot: draft.workspaceRoot,
          sourceFile: draft.sourceFile,
          symbol: draft.symbolName,
          kind: draft.symbolKind ?? 'unknown',
          signature: draft.symbolSignature,
          lineHint: draft.lineHint,
          content: draft.content.trim(),
          tags,
        });
      }

      if (!draft.line || !draft.column) {
        throw new Error('Line note is missing an anchor position.');
      }

      return this.cliClient.addLineNote({
        workspaceRoot: draft.workspaceRoot,
        sourceFile: draft.sourceFile,
        line: draft.line,
        column: draft.column,
        content: draft.content.trim(),
        tags,
      });
    }

    if (!draft.noteId) {
      throw new Error('Edited note is missing an id.');
    }

    return this.cliClient.updateNote({
      workspaceRoot: draft.workspaceRoot,
      sourceFile: draft.sourceFile,
      noteId: draft.noteId,
      content: draft.content.trim(),
      tags,
      clearTags: tags.length === 0,
      expectedUpdatedAt: draft.expectedUpdatedAt,
    });
  }

  public async undoRevision(
    draft: InlineNoteDraft,
    snapshot: NoteRevisionSnapshot,
  ): Promise<NoteView> {
    if (!draft.noteId) {
      throw new Error('Undo requires a persisted note id.');
    }

    return this.cliClient.updateNote({
      workspaceRoot: draft.workspaceRoot,
      sourceFile: draft.sourceFile,
      noteId: draft.noteId,
      content: snapshot.content,
      tags: snapshot.tags,
      expectedUpdatedAt: draft.expectedUpdatedAt,
    });
  }

  public buildCreateDraftForEditor(input: {
    workspaceRoot: string;
    sourceFile: string;
    line: number;
    column: number;
    symbol?: {
      name: string;
      kind: string;
      signature?: string;
      lineHint: number;
    };
  }): InlineNoteDraft {
    if (input.symbol) {
      return createSymbolCreateDraft({
        workspaceRoot: input.workspaceRoot,
        sourceFile: input.sourceFile,
        symbolName: input.symbol.name,
        symbolKind: input.symbol.kind,
        symbolSignature: input.symbol.signature,
        lineHint: input.symbol.lineHint,
      });
    }

    return createLineCreateDraft({
      workspaceRoot: input.workspaceRoot,
      sourceFile: input.sourceFile,
      line: input.line,
      column: input.column,
    });
  }

  public snapshotAfterSave(_draft: InlineNoteDraft, saved: NoteView): NoteRevisionSnapshot {
    return {
      content: saved.note.content,
      tags: [...(saved.note.tags ?? [])],
      updatedAt: saved.note.updated_at,
    };
  }

  public applyPersistedMetadata(
    draft: InlineNoteDraft,
    saved: NoteView,
    undoSnapshot: NoteRevisionSnapshot,
  ): InlineNoteDraft {
    return {
      ...draft,
      mode: 'edit',
      noteId: saved.note.id,
      expectedUpdatedAt: saved.note.updated_at,
      undoSnapshot,
    };
  }
}
