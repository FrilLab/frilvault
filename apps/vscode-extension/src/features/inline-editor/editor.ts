import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

import type { CliClient } from '../../core/cliClient';
import type { NoteAnchor, NoteView } from '../../types';
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
  formatTagsText,
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
import {
  InlineNoteDraftRecoveryStore,
  recoveryId,
} from './draftRecovery';

export interface InlineNoteEditorDependencies {
  cliClient: CliClient;
  getWorkspaceRoot?: () => string;
  refreshNoteState: () => Promise<void>;
  showErrorMessage?: (message: string) => Thenable<string | undefined>;
  showInformationMessage?: (message: string) => Thenable<string | undefined>;
  showWarningMessage?: (message: string) => Thenable<string | undefined>;
  showQuickPick?: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: vscode.QuickPickOptions,
  ) => Thenable<T | undefined>;
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
export class InlineNoteEditor implements vscode.Disposable {
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
  private recoveryStore: InlineNoteDraftRecoveryStore | undefined;
  private recoveryId: string | undefined;
  private recoverySessionId: string | undefined;
  private nativeClosePromise: Promise<void> | undefined;
  private deferredOpen: InlineNoteDraft | undefined;
  private disposed = false;
  private suspended = false;

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
        getAutoSaveDebounceMs(),
        (status) => this.handleSaveStatus(status),
        async (revision) => {
          await this.persistDraft(revision);
        },
      );
  }

  public register(context: vscode.ExtensionContext): void {
    this.context = context;
    this.recoveryStore = new InlineNoteDraftRecoveryStore(context.workspaceState);
    context.subscriptions.push(this);
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

    await this.openCreateOrEditAt(
      sourceFile,
      draftAnchor(draft),
      draft.kind === 'Symbol' ? draft.lineHint : line,
    );
  }

  public async openCreateOrEditAt(
    sourceFile: string,
    anchor: NoteAnchor,
    resolvedLine?: number,
    documentUri?: string,
  ): Promise<void> {
    const workspaceRoot = this.workspaceRoot();

    if (documentUri) {
      try {
        if (getRelativeFilePath(workspaceRoot, vscode.Uri.parse(documentUri).fsPath) !== sourceFile) {
          return;
        }
      } catch {
        return;
      }
    }

    const notes = await this.dependencies.cliClient.listNotes(workspaceRoot, sourceFile);
    const matchingNotes = notes.filter((note) => sameCanonicalAnchor(note.note.anchor, anchor));

    if (matchingNotes.length === 1) {
      this.openEdit(matchingNotes[0]);
      return;
    }

    if (matchingNotes.length > 1) {
      const showQuickPick = this.dependencies.showQuickPick ?? vscode.window.showQuickPick;
      const selected = await showQuickPick(
        matchingNotes.map((note) => ({
          label: note.note.anchor.type === 'Symbol'
            ? `${note.note.anchor.name ?? 'Symbol'} note`
            : `Line ${note.note.anchor.line ?? 1} note`,
          description: notePreview(note),
          note,
        })),
        { title: 'Select note to edit', placeHolder: 'Choose a note at this anchor' },
      );

      if (selected) {
        this.openEdit(selected.note);
      }
      return;
    }

    const anchorLine = resolvedLine ?? anchor.line ?? anchor.line_hint ?? 1;
    const draft = this.service.buildCreateDraftForEditor({
      workspaceRoot,
      sourceFile,
      line: anchor.type === 'Line' ? anchor.line ?? anchorLine : anchorLine,
      column: anchor.type === 'Line' ? anchor.column ?? 1 : 1,
      symbol: anchor.type === 'Symbol'
        ? {
            name: anchor.name ?? '',
            kind: normalizeSymbolKind(anchor.kind),
            signature: anchor.signature,
            lineHint: anchorLine,
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
    if (this.disposed) {
      return;
    }

    if (!this.context) {
      throw new Error('Inline note editor is not registered.');
    }

    if (this.nativeClosePromise) {
      this.deferredOpen = draft;
      return;
    }

    this.openDraftNow(draft);
  }

  private openDraftNow(draft: InlineNoteDraft): void {
    const context = this.context;

    if (!context) {
      throw new Error('Inline note editor is not registered.');
    }

    const id = recoveryId(draft);
    const recovered = this.recoveryStore?.get(draft);
    const recoveredMatchesPersisted = recovered?.draft.expectedUpdatedAt === draft.expectedUpdatedAt;
    const recoveredMatchesContent = recovered &&
      draftFingerprint(recovered.draft.content, recovered.draft.tagsText) !==
        draftFingerprint(draft.content, draft.tagsText);
    const shouldRestore = Boolean(recovered && recoveredMatchesContent);
    const initialDraft = shouldRestore && recovered ? recovered.draft : draft;
    const isConflictingRecovery = Boolean(shouldRestore && !recoveredMatchesPersisted);

    this.draft = initialDraft;
    this.draftRevision = shouldRestore && recovered ? recovered.revision : 0;
    this.lastPersistedRevision = 0;
    this.draftSnapshots.clear();
    this.draftSnapshots.set(this.draftRevision, initialDraft);
    this.conflictDraft = isConflictingRecovery ? initialDraft : undefined;
    this.recoveryId = id;
    this.recoverySessionId = recovered?.sessionId ?? randomUUID();
    this.autoSave.reset(draftFingerprint(
      shouldRestore && recoveredMatchesPersisted ? draft.content : initialDraft.content,
      shouldRestore && recoveredMatchesPersisted ? draft.tagsText : initialDraft.tagsText,
    ));
    this.handleSaveStatus(isConflictingRecovery ? 'conflict' : 'saved');

    if (recovered && !shouldRestore) {
      void this.recoveryStore?.clear(id, recovered.sessionId, recovered.revision)
        .catch(() => undefined);
    }

    this.panel.open(
      context,
      initialDraft,
      async (message) => {
        await this.handlePanelMessage(message);
      },
      async () => {
        await this.handleNativePanelClose();
      },
    );

    if (isConflictingRecovery && recovered) {
      this.panel.updateDraft(initialDraft, {
        errorMessage: 'This recovered draft is based on an earlier version of the note.',
        status: 'conflict',
      });
    } else if (shouldRestore && recovered) {
      this.autoSave.schedule(
        draftFingerprint(initialDraft.content, initialDraft.tagsText),
        this.draftRevision,
      );
      void this.dependencies.showInformationMessage?.('Recovered unsaved changes for this note.');
    }

    void this.refreshTagSuggestions(initialDraft.workspaceRoot);
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
        await this.handlePanelClose(false);
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

    if (this.suspended) {
      this.panel.updateDraft(this.draft, {
        errorMessage: 'FrilVault is disabled. This draft will save when FrilVault is enabled.',
        status: 'editing',
      });
    } else {
      this.autoSave.schedule(draftFingerprint(content, tagsText), this.draftRevision);
    }

    await this.persistRecoveryDraft(this.draftRevision, this.draft);
  }

  private async handlePanelClose(nativeClose: boolean): Promise<void> {
    if (!this.draft) {
      if (!nativeClose) {
        this.panel.close();
      }
      return;
    }

    await this.autoSave.flush();

    if (this.saveStatus === 'failed' || this.saveStatus === 'conflict') {
      if (!nativeClose) {
        this.panel.updateDraft(this.draft, {
          errorMessage: this.saveStatus === 'conflict'
            ? 'Resolve the external change before closing this note.'
            : 'Save failed. Retry or keep editing before closing.',
          status: this.saveStatus,
        });
      }
      return;
    }

    this.autoSave.cancel();
    if (!nativeClose) {
      this.panel.close();
    }
    this.draft = undefined;
    this.conflictDraft = undefined;
  }

  private async handleNativePanelClose(): Promise<void> {
    const closing = this.handlePanelClose(true);
    this.nativeClosePromise = closing;

    try {
      await closing;
    } finally {
      if (this.nativeClosePromise === closing) {
        this.nativeClosePromise = undefined;
      }

      const deferred = this.deferredOpen;
      this.deferredOpen = undefined;

      if (deferred) {
        const latest = await this.latestPersistedDraft(deferred);
        this.openDraftNow(latest);
      }
    }
  }

  private async latestPersistedDraft(draft: InlineNoteDraft): Promise<InlineNoteDraft> {
    if (draft.mode !== 'edit' || !draft.noteId) {
      return draft;
    }

    try {
      const notes = await this.dependencies.cliClient.listNotes(draft.workspaceRoot, draft.sourceFile);
      const latest = notes.find((note) => note.note.id === draft.noteId);
      return latest ? createEditDraft(latest, draft.workspaceRoot) : draft;
    } catch {
      return draft;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.autoSave.cancel();
    this.panel.close();
    this.draft = undefined;
    this.conflictDraft = undefined;
    this.deferredOpen = undefined;
  }

  public suspend(): void {
    if (this.disposed || this.suspended) {
      return;
    }

    this.suspended = true;
    this.autoSave.cancel();

    if (this.draft) {
      this.panel.updateDraft(this.draft, {
        errorMessage: 'FrilVault is disabled. This draft will save when FrilVault is enabled.',
        status: 'editing',
      });
    }
  }

  public resume(): void {
    if (this.disposed || !this.suspended) {
      return;
    }

    this.suspended = false;
    if (!this.draft) {
      return;
    }

    const persistedDraft = this.draftSnapshots.get(this.lastPersistedRevision) ?? this.draft;
    const persistedFingerprint = draftFingerprint(
      persistedDraft.content,
      persistedDraft.tagsText,
    );
    this.autoSave.reset(persistedFingerprint);

    const currentFingerprint = draftFingerprint(this.draft.content, this.draft.tagsText);
    if (currentFingerprint === persistedFingerprint) {
      this.handleSaveStatus('saved');
      return;
    }

    this.autoSave.schedule(currentFingerprint, this.draftRevision);
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
      if (this.recoveryStore && this.recoveryId && this.recoverySessionId) {
        try {
          await this.recoveryStore.clear(
            this.recoveryId,
            this.recoverySessionId,
            Number.MAX_SAFE_INTEGER,
          );
        } catch (error) {
          await this.reportOptionalFailure('clearing the deleted note recovery copy', error, 'deleted');
        }
      }

      try {
        await this.dependencies.refreshNoteState();
      } catch (error) {
        await this.reportOptionalFailure('refreshing note views', error, 'deleted');
      }

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

    let saved: NoteView;

    try {
      saved = await this.service.saveDraft(draftAtSaveStart);
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

    if (revision < this.lastPersistedRevision) {
      return;
    }

    this.lastPersistedRevision = revision;

    if (!this.disposed && this.draft) {
      const undoSnapshot = draftAtSaveStart.undoSnapshot ?? revisionFromDraft(draftAtSaveStart);
      const savedSnapshot = this.service.snapshotAfterSave(draftAtSaveStart, saved);
      this.syncPersistedMetadata(revision, saved, undoSnapshot, savedSnapshot);
    }

    if (this.disposed || this.suspended || !this.draft) {
      if (this.recoveryStore && this.recoveryId && this.recoverySessionId) {
        try {
          await this.recoveryStore.clear(this.recoveryId, this.recoverySessionId, revision);
        } catch {
          // A later open can compare the recovery draft with the persisted Note.
        }
      }
      return;
    }

    if (this.recoveryStore && this.recoveryId && this.recoverySessionId) {
      try {
        await this.recoveryStore.clear(this.recoveryId, this.recoverySessionId, revision);
      } catch (error) {
        await this.reportOptionalFailure('clearing the saved draft recovery copy', error, 'saved');
      }
    }

    this.panel.updateDraft(this.draft, { status: 'saved', canDelete: true });

    try {
      await this.dependencies.refreshNoteState();
    } catch (error) {
      await this.reportOptionalFailure('refreshing note views', error, 'saved');
    }

    await this.refreshTagSuggestions(draftAtSaveStart.workspaceRoot, 'saved');
  }

  private async handleKeepLocalVersion(): Promise<void> {
    if (!this.conflictDraft) {
      return;
    }

    const localDraft = this.conflictDraft;
    let latest: NoteView | undefined;

    try {
      const latestNotes = await this.dependencies.cliClient.listNotes(
        localDraft.workspaceRoot,
        localDraft.sourceFile,
      );
      latest = latestNotes.find((note) => note.note.id === localDraft.noteId);
    } catch (error) {
      this.panel.updateDraft(localDraft, {
        errorMessage: formatError(error, 'Failed to load the current note version.'),
        status: 'conflict',
      });
      return;
    }

    if (!latest) {
      this.panel.updateDraft(localDraft, {
        errorMessage: 'This note no longer exists. The recovered draft is still available.',
        status: 'conflict',
      });
      return;
    }

    this.draft = {
      ...localDraft,
      expectedUpdatedAt: latest.note.updated_at,
      undoSnapshot: {
        content: latest.note.content,
        tags: [...(latest.note.tags ?? [])],
        updatedAt: latest.note.updated_at,
      },
    };
    this.conflictDraft = undefined;
    this.draftRevision += 1;
    this.draftSnapshots.set(this.draftRevision, this.draft);
    this.autoSave.reset(draftFingerprint(latest.note.content, formatTagsText(latest.note.tags)));
    await this.persistRecoveryDraft(this.draftRevision, this.draft);
    this.autoSave.schedule(
      draftFingerprint(this.draft.content, this.draft.tagsText),
      this.draftRevision,
    );
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
      return;
    }

    if (this.recoveryStore && this.recoveryId && this.recoverySessionId) {
      try {
        await this.recoveryStore.clear(this.recoveryId, this.recoverySessionId, Number.MAX_SAFE_INTEGER);
      } catch (error) {
        await this.reportOptionalFailure('clearing the resolved recovery copy', error);
      }
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

  private async reportOptionalFailure(
    action: string,
    error: unknown,
    result?: 'saved' | 'deleted',
  ): Promise<void> {
    const showWarningMessage =
      this.dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
    const detail = error instanceof Error ? error.message : 'Unknown error';
    const message = result
      ? `FrilVault note ${result}, but ${action} failed: ${detail}`
      : `FrilVault could not complete ${action}: ${detail}`;

    try {
      await showWarningMessage(message);
    } catch {
      // UI reporting is optional after the persisted Note is already safe.
    }
  }

  private async persistRecoveryDraft(revision: number, draft: InlineNoteDraft): Promise<void> {
    if (!this.recoveryStore || !this.recoveryId || !this.recoverySessionId) {
      return;
    }

    try {
      await this.recoveryStore.write(
        this.recoveryId,
        this.recoverySessionId,
        revision,
        draft,
      );
    } catch (error) {
      this.panel.updateDraft(draft, {
        errorMessage: formatError(error, 'Could not store a recovery copy of this draft.'),
        status: this.saveStatus,
      });
    }
  }

  private async refreshTagSuggestions(
    workspaceRoot: string,
    noteResult?: 'saved' | 'deleted',
  ): Promise<void> {
    try {
      const tags = await this.dependencies.cliClient.tagList(workspaceRoot);
      if (this.draft?.workspaceRoot !== workspaceRoot) {
        return;
      }
      this.panel.updateTagSuggestions?.(tags.map((item) => item.tag));
      this.panel.updateTagMetadata?.(tags);
    } catch (error) {
      await this.reportOptionalFailure('refreshing tag suggestions', error, noteResult);
    }
  }
}

function draftAnchor(draft: InlineNoteDraft): NoteAnchor {
  if (draft.kind === 'Symbol') {
    return {
      type: 'Symbol',
      name: draft.symbolName,
      kind: draft.symbolKind,
      signature: draft.symbolSignature,
      line_hint: draft.lineHint,
    };
  }

  return {
    type: 'Line',
    line: draft.line,
    column: draft.column,
  };
}

function sameCanonicalAnchor(left: NoteAnchor, right: NoteAnchor): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === 'Line' && right.type === 'Line') {
    return (left.line ?? 1) === (right.line ?? 1) &&
      (left.column ?? 1) === (right.column ?? 1);
  }

  return left.type === 'Symbol' && right.type === 'Symbol' &&
    left.name === right.name &&
    normalizeSymbolKind(left.kind) === normalizeSymbolKind(right.kind) &&
    left.signature === right.signature;
}

function normalizeSymbolKind(kind: string | undefined): string {
  const value = kind?.toLocaleLowerCase();
  return ['function', 'struct', 'enum', 'trait', 'impl', 'method'].includes(value ?? '')
    ? value!
    : 'unknown';
}

function notePreview(note: NoteView): string {
  const firstLine = note.note.content
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  const content = Array.from(firstLine).slice(0, 64).join('');
  const tags = (note.note.tags ?? []).map((tag) => `#${tag}`).join(' ');
  return [content, tags].filter(Boolean).join(' · ') || 'Empty note';
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

const DEFAULT_DEBOUNCE_MS = 900;

export function getAutoSaveDebounceMs(): number {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<number>('inlineEditor.autoSaveDebounceMs', DEFAULT_DEBOUNCE_MS);

  if (!Number.isFinite(configured) || configured < 100) {
    return DEFAULT_DEBOUNCE_MS;
  }

  return Math.floor(configured);
}
