import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { getInlineNotesDebounceMs } from '../presentation/inlinePreviewSettings';
import type { NoteView } from '../../types';
import {
  getActiveEditorOrThrow,
  getRelativeFilePath,
  getWorkspaceRoot,
} from '../../utils/file';
import {
  findSymbolAnchorAtPosition,
  mapDocumentSymbolKind,
  readSymbolSignature,
} from '../../utils/symbols';
import {
  type AutoSaveController,
  AutoSaveStatus,
  DebouncedAutoSave,
  draftFingerprint,
} from './autoSave';
import {
  applyFormInput,
  createEditDraft,
  revisionFromDraft,
  validateInlineNoteForm,
  type InlineNoteDraft,
  type NoteRevisionSnapshot,
} from './draft';
import {
  InlineNotePanel,
  type InlineNotePanelLike,
  type InlineNotePanelMessage,
} from './panel';
import { InlineNoteEditorService } from './service';

export interface InlineNoteEditorDependencies {
  cliClient: CliClient;
  getWorkspaceRoot?: () => string;
  refreshNoteState: () => Promise<void>;
  runOptionalPostSaveTasks?: () => Promise<void>;
  showErrorMessage?: (message: string) => Thenable<string | undefined>;
  showInformationMessage?: (message: string) => Thenable<string | undefined>;
  showWarningMessage?: (message: string) => Thenable<string | undefined>;
  createAutoSave?: (
    onStatusChange: (status: AutoSaveStatus) => void,
    persist: (revision: number) => Promise<void>,
  ) => AutoSaveController;
  panel?: InlineNotePanelLike;
}

/**
 * Webview-based inline note editor with debounced auto-save.
 *
 * webview 기반 inline note editor이며 debounced auto-save를 사용합니다.
 */
export class InlineNoteEditor {
  private readonly panel: InlineNotePanelLike;
  private readonly service: InlineNoteEditorService;
  private readonly autoSave: AutoSaveController;
  private draft: InlineNoteDraft | undefined;
  private context: vscode.ExtensionContext | undefined;
  private saveStatus: AutoSaveStatus = 'saved';
  private conflictDraft: InlineNoteDraft | undefined;
  private draftRevision = 0;
  private lastPersistedRevision = 0;
  private readonly draftSnapshots = new Map<number, InlineNoteDraft>();

  public constructor(private readonly dependencies: InlineNoteEditorDependencies) {
    this.panel = dependencies.panel ?? new InlineNotePanel();
    this.service = new InlineNoteEditorService(dependencies.cliClient);
    this.autoSave =
      dependencies.createAutoSave?.(
        (status) => this.handleSaveStatus(status),
        async (revision) => {
          await this.persistDraft(revision);
        },
      ) ??
      new DebouncedAutoSave(
        getInlineNotesDebounceMs(),
        (status) => this.handleSaveStatus(status),
        async (revision) => {
          await this.persistDraft(revision);
        },
      );
  }

  public register(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  public async openCreateHere(): Promise<void> {
    const editor = getActiveEditorOrThrow();
    const workspaceRoot = this.workspaceRoot();
    const sourceFile = getRelativeFilePath(workspaceRoot, editor.document.uri.fsPath);
    const position = editor.selection.active;
    const line = position.line + 1;
    const column = position.character + 1;

    const symbol = await findSymbolAnchorAtPosition(editor.document, position);
    const draft = this.service.buildCreateDraftForEditor({
      workspaceRoot,
      sourceFile,
      line,
      column,
      symbol: symbol
        ? {
            name: symbol.name,
            kind: mapDocumentSymbolKind(symbol.kind),
            signature: readSymbolSignature(editor.document, symbol),
            lineHint: symbol.range.start.line + 1,
          }
        : undefined,
    });

    this.openDraft(draft);
  }

  public openEdit(noteView: NoteView): void {
    this.openDraft(createEditDraft(noteView, this.workspaceRoot()));
  }

  public openEditById(noteId: string, sourceFile: string, noteView?: NoteView): void {
    if (noteView) {
      this.openEdit(noteView);
      return;
    }

    this.openEdit({
      source_file: sourceFile,
      note: {
        id: noteId,
        content: '',
        anchor: { type: 'Line', line: 1, column: 1 },
      },
    });
  }

  private openDraft(draft: InlineNoteDraft): void {
    if (!this.context) {
      throw new Error('Inline note editor is not registered.');
    }

    this.draft = draft;
    this.draftRevision = 0;
    this.lastPersistedRevision = 0;
    this.draftSnapshots.clear();
    this.draftSnapshots.set(0, draft);
    this.conflictDraft = undefined;
    this.autoSave.reset(draftFingerprint(draft.content, draft.tagsText));
    this.handleSaveStatus('saved');

    this.panel.open(
      this.context,
      draft,
      async (message) => {
        await this.handlePanelMessage(message);
      },
      async () => {
        await this.handlePanelClose();
      },
    );

    void this.refreshTagSuggestions(draft.workspaceRoot);
  }

  private async handlePanelMessage(message: InlineNotePanelMessage): Promise<void> {
    if (!this.draft) {
      return;
    }

    switch (message.type) {
      case 'change':
        await this.handleChange(message.content, message.tagsText);
        break;
      case 'compositionStart':
        this.autoSave.startComposition();
        break;
      case 'compositionEnd':
        this.autoSave.endComposition();
        await this.handleChange(message.content, message.tagsText);
        break;
      case 'requestTagSuggestions':
        await this.refreshTagSuggestions(this.draft.workspaceRoot);
        break;
      case 'close':
        await this.handlePanelClose(true);
        break;
      case 'delete':
        await this.handleDelete();
        break;
      case 'retry':
        await this.autoSave.flush();
        break;
      case 'keepLocal':
        await this.handleKeepLocalVersion();
        break;
      case 'loadExternal':
        await this.handleLoadExternalVersion();
        break;
    }
  }

  private async handleChange(content: string, tagsText: string): Promise<void> {
    if (!this.draft || this.saveStatus === 'conflict') {
      return;
    }

    this.draft = applyFormInput(this.draft, { content, tagsText });
    this.draftRevision += 1;
    this.draftSnapshots.set(this.draftRevision, this.draft);
    this.autoSave.schedule(draftFingerprint(content, tagsText), this.draftRevision);
  }

  private async handlePanelClose(forceClose = false): Promise<void> {
    if (!this.draft) {
      this.panel.close();
      return;
    }

    await this.autoSave.flush();

    if (this.saveStatus === 'failed' && !forceClose) {
      this.panel.updateDraft(this.draft, {
        errorMessage: 'Save failed. Retry or keep editing before closing.',
        status: this.saveStatus,
      });
      return;
    }

    this.autoSave.cancel();
    this.panel.close();
    this.draft = undefined;
    this.conflictDraft = undefined;
  }

  private async handleDelete(): Promise<void> {
    const noteId = this.draft?.noteId;

    if (!this.draft || !noteId) {
      return;
    }

    const draft = this.draft;

    const showWarningMessage =
      this.dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
    const confirmed = await showWarningMessage(
      'Delete this FrilVault note?',
      { modal: true },
      'Delete',
    );

    if (confirmed !== 'Delete') {
      return;
    }

    try {
      await this.dependencies.cliClient.deleteNote(
        draft.workspaceRoot,
        draft.sourceFile,
        noteId,
      );
      await this.dependencies.refreshNoteState();
      this.autoSave.cancel();
      this.panel.close();
      this.draft = undefined;
    } catch (error) {
      this.panel.updateDraft(draft, {
        errorMessage: formatError(error, 'Failed to delete note.'),
        status: this.saveStatus,
      });
    }
  }

  private async persistDraft(revision: number): Promise<void> {
    const draftAtSaveStart = this.draftSnapshots.get(revision);

    if (!this.draft || !draftAtSaveStart || revision < this.lastPersistedRevision) {
      return;
    }

    const validationError = validateInlineNoteForm({
      content: draftAtSaveStart.content,
      tagsText: draftAtSaveStart.tagsText,
    });

    if (validationError) {
      this.panel.updateDraft(draftAtSaveStart, {
        errorMessage: validationError,
        status: 'failed',
      });
      throw new Error(validationError);
    }

    try {
      const undoSnapshot = draftAtSaveStart.undoSnapshot ?? revisionFromDraft(draftAtSaveStart);
      const saved = await this.service.saveDraft(draftAtSaveStart);

      if (!this.draft || revision < this.lastPersistedRevision) {
        return;
      }

      this.lastPersistedRevision = revision;
      const savedSnapshot = this.service.snapshotAfterSave(draftAtSaveStart, saved);
      this.syncPersistedMetadata(revision, saved, undoSnapshot, savedSnapshot);

      this.panel.updateDraft(this.draft, { status: 'saved', canDelete: true });

      try {
        await this.dependencies.refreshNoteState();
      } catch (error) {
        await this.reportOptionalFailure('refreshing note views', error);
      }

      await this.refreshTagSuggestions(draftAtSaveStart.workspaceRoot);

      void this.dependencies.runOptionalPostSaveTasks?.().catch(async (error) => {
        await this.reportOptionalFailure('running post-save tasks', error);
      });
    } catch (error) {
      if (!this.draft || revision < this.lastPersistedRevision) {
        return;
      }

      if (isConcurrentModificationError(error)) {
        this.conflictDraft = this.draft;
        this.handleSaveStatus('conflict');
        this.panel.updateDraft(this.draft, {
          errorMessage: 'This note was changed elsewhere.',
          status: 'conflict',
        });
        throw error;
      }

      this.panel.updateDraft(this.draft, {
        errorMessage: formatError(error, 'Failed to save note.'),
        status: 'failed',
      });
      throw error;
    }
  }

  private async handleKeepLocalVersion(): Promise<void> {
    if (!this.conflictDraft) {
      return;
    }

    this.draft = this.conflictDraft;
    this.conflictDraft = undefined;
    this.handleSaveStatus('editing');
    await this.autoSave.flush();
  }

  private async handleLoadExternalVersion(): Promise<void> {
    if (!this.draft?.noteId) {
      return;
    }

    try {
      const notes = await this.dependencies.cliClient.listNotes(
        this.draft.workspaceRoot,
        this.draft.sourceFile,
      );
      const latest = notes.find((note) => note.note.id === this.draft?.noteId);

      if (!latest) {
        throw new Error('Note no longer exists.');
      }

      this.draft = createEditDraft(latest, this.draft.workspaceRoot);
      this.draftRevision = 0;
      this.lastPersistedRevision = 0;
      this.draftSnapshots.clear();
      this.draftSnapshots.set(0, this.draft);
      this.conflictDraft = undefined;
      this.autoSave.reset(draftFingerprint(this.draft.content, this.draft.tagsText));
      this.handleSaveStatus('saved');
      this.panel.updateDraft(this.draft, { status: 'saved', replaceInputs: true });
    } catch (error) {
      this.panel.updateDraft(this.draft, {
        errorMessage: formatError(error, 'Failed to load the external version.'),
        status: 'conflict',
      });
    }
  }

  private handleSaveStatus(status: AutoSaveStatus): void {
    this.saveStatus = status;

    if (this.draft) {
      this.panel.updateDraft(this.draft, { status });
    }
  }

  private workspaceRoot(): string {
    return this.dependencies.getWorkspaceRoot?.() ?? getWorkspaceRoot();
  }

  private syncPersistedMetadata(
    persistedRevision: number,
    saved: NoteView,
    undoSnapshot: NoteRevisionSnapshot,
    savedSnapshot: NoteRevisionSnapshot,
  ): void {
    const synchronized = new Map<number, InlineNoteDraft>();

    for (const [revision, snapshot] of this.draftSnapshots.entries()) {
      if (revision < persistedRevision) {
        continue;
      }

      const nextSnapshot = this.service.applyPersistedMetadata(snapshot, saved, undoSnapshot);
      nextSnapshot.undoSnapshot = revision === persistedRevision ? savedSnapshot : undoSnapshot;
      synchronized.set(revision, nextSnapshot);
    }

    this.draftSnapshots.clear();

    for (const [revision, snapshot] of synchronized.entries()) {
      this.draftSnapshots.set(revision, snapshot);
    }

    this.draft = this.draftSnapshots.get(this.draftRevision)
      ?? synchronized.get(persistedRevision);
  }

  private async reportOptionalFailure(action: string, error: unknown): Promise<void> {
    const showWarningMessage =
      this.dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
    const detail = error instanceof Error ? error.message : 'Unknown error';

    await showWarningMessage(`FrilVault note saved, but ${action} failed: ${detail}`);
  }

  private async refreshTagSuggestions(workspaceRoot: string): Promise<void> {
    try {
      const tags = await this.dependencies.cliClient.tagList(workspaceRoot);
      if (this.draft?.workspaceRoot !== workspaceRoot) {
        return;
      }
      this.panel.updateTagSuggestions?.(tags.map((item) => item.tag));
      this.panel.updateTagMetadata?.(tags);
    } catch (error) {
      await this.reportOptionalFailure('refreshing tag suggestions', error);
    }
  }
}

function isConcurrentModificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('concurrent modification');
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function createInlineNoteEditor(
  dependencies: InlineNoteEditorDependencies,
): InlineNoteEditor {
  return new InlineNoteEditor(dependencies);
}
