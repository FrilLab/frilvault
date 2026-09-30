import * as vscode from 'vscode';
import * as path from 'node:path';

import type { CliClient } from '../../core/cliClient';
import type { NoteView } from '../../types';
import { ContextualRefresh } from '../refresh/contextualRefresh';
import { getVaultRoot, tryGetRelativeFilePath, tryGetWorkspaceRoot } from '../../utils/file';

export interface CurrentFileNotesSnapshot {
  workspaceRoot: string | undefined;
  sourceFile: string | undefined;
  editorDocumentUri: string | undefined;
  notes: NoteView[];
  error: string | undefined;
  loading: boolean;
}

const EMPTY_SNAPSHOT: CurrentFileNotesSnapshot = {
  workspaceRoot: undefined,
  sourceFile: undefined,
  editorDocumentUri: undefined,
  notes: [],
  error: undefined,
  loading: false,
};

/**
 * Cached note list for the active editor file.
 *
 * The store prevents stale async list responses from overwriting newer editor
 * state by tracking a monotonically increasing load generation.
 *
 * 활성 편집기 파일의 note list cache입니다.
 *
 * load generation을 증가시키며 stale async list 응답이 더 새로운 editor
 * state를 덮어쓰지 않도록 막습니다.
 */
export class CurrentFileNotesStore implements vscode.Disposable {
  private snapshot: CurrentFileNotesSnapshot = { ...EMPTY_SNAPSHOT };

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  private contextKey: string | undefined;
  private readonly refreshScheduler = new ContextualRefresh<NoteView[]>();

  public constructor(
    private readonly cliClient: CliClient,
    private readonly isEnabled: () => boolean,
    private readonly getWorkspaceRoot: () => string | undefined = tryGetWorkspaceRoot,
  ) {}

  public getSnapshot(): CurrentFileNotesSnapshot {
    return this.snapshot;
  }

  public clear(): void {
    this.refreshScheduler.clear();
    this.contextKey = undefined;
    this.setSnapshot({ ...EMPTY_SNAPSHOT });
  }

  public async syncActiveEditor(editor = vscode.window.activeTextEditor): Promise<void> {
    await this.refreshEditor(editor, false);
  }

  private async refreshEditor(
    editor: vscode.TextEditor | undefined,
    invalidated: boolean,
  ): Promise<void> {
    if (!this.isEnabled()) {
      this.clear();
      return;
    }

    if (!editor || editor.document.uri.scheme !== 'file') {
      this.clear();
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      this.contextKey = undefined;
      this.refreshScheduler.clear();
      this.setSnapshot({
        ...EMPTY_SNAPSHOT,
        editorDocumentUri: editor.document.uri.toString(),
        error: 'FrilVault requires an open workspace folder.',
      });
      return;
    }

    const sourceFile = tryGetRelativeFilePath(workspaceRoot, editor.document.uri.fsPath);
    if (!sourceFile) {
      this.contextKey = undefined;
      this.refreshScheduler.clear();
      this.setSnapshot({
        workspaceRoot,
        sourceFile: undefined,
        editorDocumentUri: editor.document.uri.toString(),
        notes: [],
        error: undefined,
        loading: false,
      });
      return;
    }

    const editorDocumentUri = editor.document.uri.toString();
    await this.refreshContext(workspaceRoot, sourceFile, editorDocumentUri, invalidated);
  }

  public async invalidateAfterMutation(editor?: vscode.TextEditor): Promise<void> {
    const activeEditor = editor ?? vscode.window.activeTextEditor;

    if (activeEditor) {
      await this.refreshEditor(activeEditor, true);
      return;
    }

    const { workspaceRoot, sourceFile, editorDocumentUri } = this.snapshot;

    if (workspaceRoot && sourceFile && editorDocumentUri) {
      await this.refreshContext(workspaceRoot, sourceFile, editorDocumentUri, true);
    }
  }

  public notesForDocument(document: vscode.TextDocument): NoteView[] {
    const snapshot = this.snapshot;

    if (snapshot.loading || snapshot.editorDocumentUri !== document.uri.toString()) {
      return [];
    }

    return snapshot.notes;
  }

  public dispose(): void {
    this.refreshScheduler.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private async refreshContext(
    workspaceRoot: string,
    sourceFile: string,
    editorDocumentUri: string,
    invalidated: boolean,
  ): Promise<void> {
    const vaultRoot = getVaultRoot(workspaceRoot);
    const key = JSON.stringify([
      path.resolve(workspaceRoot),
      path.resolve(vaultRoot),
      sourceFile,
      editorDocumentUri,
    ]);

    const sameContext = this.contextKey === key;
    this.contextKey = key;

    if (!sameContext) {
      this.setSnapshot({
        workspaceRoot,
        sourceFile,
        editorDocumentUri,
        notes: [],
        error: undefined,
        loading: true,
      });
    }

    await this.refreshScheduler.run(
      key,
      () => this.cliClient.listNotes(workspaceRoot, sourceFile),
      (notes) => {
        this.setSnapshot({
          workspaceRoot,
          sourceFile,
          editorDocumentUri,
          notes,
          error: undefined,
          loading: false,
        });
      },
      (error) => {
        const message =
          error instanceof Error ? error.message : 'Failed to load notes for the current file.';

        this.setSnapshot({
          workspaceRoot,
          sourceFile,
          editorDocumentUri,
          notes: this.contextKey === key ? this.snapshot.notes : [],
          error: message,
          loading: false,
        });
      },
      invalidated,
    );
  }

  private setSnapshot(snapshot: CurrentFileNotesSnapshot): void {
    if (snapshotsEqual(this.snapshot, snapshot)) {
      return;
    }

    this.snapshot = snapshot;
    this.onDidChangeEmitter.fire();
  }
}

function snapshotsEqual(
  left: CurrentFileNotesSnapshot,
  right: CurrentFileNotesSnapshot,
): boolean {
  return (
    left.workspaceRoot === right.workspaceRoot &&
    left.sourceFile === right.sourceFile &&
    left.editorDocumentUri === right.editorDocumentUri &&
    left.error === right.error &&
    left.loading === right.loading &&
    JSON.stringify(left.notes) === JSON.stringify(right.notes)
  );
}
