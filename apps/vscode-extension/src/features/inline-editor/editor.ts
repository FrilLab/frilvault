import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { CliClient } from '../../core/cliClient';
import type { NoteAnchor, NoteView } from '../../types';
import {
  getRelativeFilePath,
  getWorkspaceRoot,
  getWorkspaceRootForSource,
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

interface NoteTarget {
  workspaceRoot: string;
  vaultPath?: string;
  client: CliClient;
  generation: number;
}

export interface InlineNoteEditorDependencies {
  cliClient: CliClient;
  getWorkspaceRoot?: () => string;
  resolveVaultPath?: (workspaceRoot: string) => Promise<string>;
  refreshNoteState: (change?: { tagsChanged: boolean }) => Promise<void>;
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
  private deferredOpen: { draft: InlineNoteDraft; generation: number } | undefined;
  private disposed = false;
  private suspended = false;
  private generation = 0;

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

  public async openCreateHere(
    invokingEditor = vscode.window.activeTextEditor,
    requestedKind?: 'Line' | 'Symbol',
  ): Promise<void> {
    if (!invokingEditor) {
      throw new Error('Open a source file in a workspace folder to add or edit a note.');
    }
    const document = invokingEditor.document;
    if (document.uri.scheme !== 'file') {
      throw new Error('Open a source file on disk to add or edit a note.');
    }
    const workspaceRoot = this.dependencies.getWorkspaceRoot?.()
      ?? getWorkspaceRootForSource(document.uri);
    const sourceFile = getRelativeFilePath(workspaceRoot, document.uri.fsPath);
    const position = invokingEditor.selection.active;
    // Capture the Vault before any symbol provider or chooser changes focus.
    const targetPromise = this.captureTarget(workspaceRoot);
    const target = await targetPromise;
    const lineAnchor: NoteAnchor = {
      type: 'Line', line: position.line + 1, column: position.character + 1,
    };
    const symbol = requestedKind === 'Line'
      ? undefined
      : await findSymbolAnchorAtPosition(document, position);
    const symbolAnchor: NoteAnchor | undefined = symbol ? {
      type: 'Symbol',
      name: symbol.name,
      kind: mapDocumentSymbolKind(symbol.kind),
      signature: readSymbolSignature(document, symbol),
      line_hint: symbol.range.start.line + 1,
    } : undefined;

    let anchor = lineAnchor;
    if (requestedKind === 'Symbol') {
      if (!symbolAnchor) {
        throw new Error('No symbol at this cursor. Choose a Line anchor instead.');
      }
      anchor = symbolAnchor;
    } else if (symbolAnchor) {
      const showQuickPick = this.dependencies.showQuickPick ?? vscode.window.showQuickPick;
      const selected = await showQuickPick([
        { label: `Line ${lineAnchor.line}:${lineAnchor.column}`, anchor: lineAnchor },
        { label: `Symbol ${symbolAnchor.name}`, description: `Declaration at line ${symbolAnchor.line_hint}`, anchor: symbolAnchor },
      ], { title: 'Add / Edit Note: choose anchor', placeHolder: 'Line position or symbol identity' });
      if (!selected) {
        return;
      }
      anchor = selected.anchor;
    }
    await this.openAtTarget(target, sourceFile, anchor);
  }

  public async openCreateOrEditAt(
    sourceFile: string,
    anchor: NoteAnchor,
    resolvedLine?: number,
    documentUri?: string,
  ): Promise<void> {
    const workspaceRoot = this.dependencies.getWorkspaceRoot?.()
      ?? (documentUri ? getWorkspaceRootForSource(vscode.Uri.parse(documentUri)) : this.workspaceRoot());
    if (documentUri) {
      try {
        if (getRelativeFilePath(workspaceRoot, vscode.Uri.parse(documentUri).fsPath) !== sourceFile) {
          return;
        }
      } catch {
        return;
      }
    }
    const target = await this.captureTarget(workspaceRoot);
    await this.openAtTarget(target, sourceFile, anchor, resolvedLine);
  }

  private async captureTarget(workspaceRoot: string): Promise<NoteTarget> {
    const generation = this.generation;
    const vaultPath = await this.dependencies.resolveVaultPath?.(workspaceRoot);
    return {
      workspaceRoot,
      vaultPath,
      generation,
      client: vaultPath ? this.dependencies.cliClient.withVaultPath(vaultPath) : this.dependencies.cliClient,
    };
  }

  private async openAtTarget(
    target: NoteTarget,
    sourceFile: string,
    anchor: NoteAnchor,
    resolvedLine?: number,
  ): Promise<void> {
    getRelativeFilePath(target.workspaceRoot, path.resolve(target.workspaceRoot, sourceFile));
    if (target.vaultPath) {
      const relativeToVault = path.relative(target.vaultPath, path.resolve(target.workspaceRoot, sourceFile));
      if (relativeToVault === '' || (!relativeToVault.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToVault))) {
        throw new Error('Open a source file outside the selected Vault to add or edit a note.');
      }
    }
    const notes = await target.client.listNotes(target.workspaceRoot, sourceFile);
    const matchingNotes = notes.filter((note) => sameCanonicalAnchor(note.note.anchor, anchor))
      .sort((left, right) => (left.note.created_at ?? '').localeCompare(right.note.created_at ?? '')
        || left.note.id.localeCompare(right.note.id));
    let note = matchingNotes[0];
    if (matchingNotes.length > 1) {
      const showQuickPick = this.dependencies.showQuickPick ?? vscode.window.showQuickPick;
      const selected = await showQuickPick(
        matchingNotes.map((entry) => ({
          label: notePreview(entry),
          description: entry.note.id,
          detail: entry.note.created_at,
          note: entry,
        })),
        { title: 'Select legacy note to edit', placeHolder: 'Each existing note is preserved' },
      );
      if (!selected) {
        return;
      }
      note = selected.note;
    }
    if (note) {
      await this.openDraft({ ...createEditDraft(note, target.workspaceRoot), vaultPath: target.vaultPath }, target.generation);
      return;
    }
    const anchorLine = resolvedLine ?? anchor.line ?? anchor.line_hint ?? 1;
    const draft = this.service.buildCreateDraftForEditor({
      workspaceRoot: target.workspaceRoot,
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
    await this.openDraft({ ...draft, vaultPath: target.vaultPath }, target.generation);
  }

  public async prepareEdit(): Promise<(noteView: NoteView) => Promise<void>> {
    const target = await this.captureTarget(this.workspaceRoot());
    return async (noteView) => {
      await this.openDraft({ ...createEditDraft(noteView, target.workspaceRoot), vaultPath: target.vaultPath }, target.generation);
    };
  }

  public async openEdit(noteView: NoteView): Promise<void> {
    const edit = await this.prepareEdit();
    await edit(noteView);
  }

  public async openEditById(noteId: string, sourceFile: string, noteView?: NoteView): Promise<void> {
    if (noteView) {
      await this.openEdit(noteView);
      return;
    }
    const target = await this.captureTarget(this.workspaceRoot());
    const notes = await target.client.listNotes(target.workspaceRoot, sourceFile);
    const matches = notes.filter((note) => note.note.id === noteId);
    if (matches.length !== 1) {
      throw new Error('The selected note is missing or has an ambiguous ID. Refresh the Notes view.');
    }
    await this.openDraft({ ...createEditDraft(matches[0], target.workspaceRoot), vaultPath: target.vaultPath }, target.generation);
  }

  private async openDraft(draft: InlineNoteDraft, generation = this.generation): Promise<void> {
    if (this.disposed || this.suspended || generation !== this.generation) {
      return;
    }

    if (!this.context) {
      throw new Error('Inline note editor is not registered.');
    }

    if (this.nativeClosePromise) {
      this.deferredOpen = { draft, generation };
      return;
    }

    if (this.draft && this.panel.isOpen()) {
      if (recoveryId(this.draft) === recoveryId(draft)) {
        this.panel.reveal?.();
        return;
      }
      await this.autoSave.flush();
      if (this.saveStatus === 'failed' || this.saveStatus === 'conflict') {
        throw new Error('Save or recover the current note before opening another note.');
      }
      if (this.disposed || this.suspended || generation !== this.generation) {
        return;
      }
      draft = await this.latestPersistedDraft(draft);
    }
    if (!this.disposed && !this.suspended && generation === this.generation) {
      this.openDraftNow(draft);
    }
  }

  private openDraftNow(draft: InlineNoteDraft): void {
    const context = this.context;

    if (!context) {
      throw new Error('Inline note editor is not registered.');
    }

    const recovered = this.recoveryStore?.get(draft);
    const id = recovered?.id ?? recoveryId(draft);
    const recoveredMatchesPersisted = recovered?.draft.expectedUpdatedAt === draft.expectedUpdatedAt;
    const recoveredMatchesContent = recovered &&
      draftFingerprint(recovered.draft.content, recovered.draft.tagsText) !==
        draftFingerprint(draft.content, draft.tagsText);
    const shouldRestore = Boolean(recovered && recoveredMatchesContent);
    const initialDraft = shouldRestore && recovered
      ? { ...recovered.draft, vaultPath: draft.vaultPath }
      : draft;
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

    void this.refreshTagSuggestions(initialDraft);
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
        await this.refreshTagSuggestions(this.draft);
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
        const latest = await this.latestPersistedDraft(deferred.draft);
        if (!this.disposed && !this.suspended && deferred.generation === this.generation) {
          this.openDraftNow(latest);
        }
      }
    }
  }

  private async latestPersistedDraft(draft: InlineNoteDraft): Promise<InlineNoteDraft> {
    if (draft.mode !== 'edit' || !draft.noteId) {
      return draft;
    }

    try {
      const notes = await this.service.clientForDraft(draft).listNotes(draft.workspaceRoot, draft.sourceFile);
      const latest = notes.find((note) => note.note.id === draft.noteId);
      return latest ? { ...createEditDraft(latest, draft.workspaceRoot), vaultPath: draft.vaultPath } : draft;
    } catch {
      return draft;
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
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
    this.generation += 1;
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
      await this.service.clientForDraft(draft).deleteNote(
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
        await this.dependencies.refreshNoteState({ tagsChanged: true });
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
      await this.dependencies.refreshNoteState({
        tagsChanged: !sameTags(draftAtSaveStart.tagsText, saved.note.tags ?? []),
      });
    } catch (error) {
      await this.reportOptionalFailure('refreshing note views', error, 'saved');
    }

    await this.refreshTagSuggestions(draftAtSaveStart, 'saved');
  }

  private async handleKeepLocalVersion(): Promise<void> {
    if (!this.conflictDraft) {
      return;
    }

    const localDraft = this.conflictDraft;
    let latest: NoteView | undefined;

    try {
      const latestNotes = await this.service.clientForDraft(localDraft).listNotes(
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
      const notes = await this.service.clientForDraft(this.draft).listNotes(
        this.draft.workspaceRoot,
        this.draft.sourceFile,
      );
      const latest = notes.find((note) => note.note.id === this.draft?.noteId);

      if (!latest) {
        throw new Error('Note no longer exists.');
      }

      this.draft = { ...createEditDraft(latest, this.draft.workspaceRoot), vaultPath: this.draft.vaultPath };
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
    draft: InlineNoteDraft,
    noteResult?: 'saved' | 'deleted',
  ): Promise<void> {
    try {
      const tags = await this.service.clientForDraft(draft).tagList(draft.workspaceRoot);
      if (this.draft?.workspaceRoot !== draft.workspaceRoot || this.draft?.vaultPath !== draft.vaultPath) {
        return;
      }
      this.panel.updateTagSuggestions?.(tags.map((item) => item.tag));
      this.panel.updateTagMetadata?.(tags);
    } catch (error) {
      await this.reportOptionalFailure('refreshing tag suggestions', error, noteResult);
    }
  }
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
    (left.signature ?? undefined) === (right.signature ?? undefined);
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

function sameTags(tagsText: string, tags: string[]): boolean {
  const normalize = (values: string[]) => [...new Set(values
    .map((tag) => tag.trim().replace(/^#+/, '').trim().toLocaleLowerCase())
    .filter(Boolean))].sort();

  return JSON.stringify(normalize(tagsText.split(','))) === JSON.stringify(normalize(tags));
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
