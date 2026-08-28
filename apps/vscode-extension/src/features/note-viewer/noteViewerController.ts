/**
 * Coordinates note viewer rendering with the current-file notes store.
 *
 * 현재 파일 notes store와 note viewer 렌더링을 조정합니다.
 */
import * as vscode from 'vscode';

import type { CurrentFileNotesStore } from '../current-file/store';
import { buildNoteViewerItems } from './noteViewerModel';
import { NoteViewerRenderer } from './noteViewerRenderer';
import { NoteViewerState } from './noteViewerState';

export type NoteViewerDefaultState = 'collapsed' | 'expanded';

const DEFAULT_STATE: NoteViewerDefaultState = 'collapsed';

export function getConfiguredDefaultState(): NoteViewerDefaultState {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<string>('noteViewer.defaultState', DEFAULT_STATE);

  return configured === 'expanded' ? 'expanded' : 'collapsed';
}

export function isNoteViewerEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('frilvault')
    .get<boolean>('noteViewer.enabled', true);
}

export class NoteViewerController implements vscode.Disposable {
  private readonly renderer: NoteViewerRenderer;
  private readonly viewerState: NoteViewerState;
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  private readonly configListener: vscode.Disposable;
  private readonly closeDocumentListener: vscode.Disposable;
  private providerRegistration: vscode.Disposable | undefined;

  public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  public constructor(
    private readonly store: CurrentFileNotesStore,
    private readonly isEnabled: () => boolean = () => true,
  ) {
    this.renderer = new NoteViewerRenderer();
    this.viewerState = new NoteViewerState();
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('frilvault.noteViewer')) {
        this.refresh();
      }
    });
    this.closeDocumentListener = vscode.workspace.onDidCloseTextDocument((document) => {
      this.viewerState.clearDocument(document.uri.toString());
      this.refresh();
    });
  }

  public register(context: vscode.ExtensionContext): void {
    if (this.providerRegistration) {
      return;
    }

    this.providerRegistration = vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      this,
    );
    context.subscriptions.push(this.providerRegistration);
  }

  public refresh(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    if (
      token.isCancellationRequested ||
      !this.isEnabled() ||
      !isNoteViewerEnabled() ||
      document.uri.scheme !== 'file'
    ) {
      return [];
    }

    const snapshot = this.store.getSnapshot();
    if (snapshot.loading || snapshot.editorDocumentUri !== document.uri.toString()) {
      return [];
    }

    const items = buildNoteViewerItems(
      this.store.notesForDocument(document),
      getConfiguredDefaultState(),
    ).map((item) => ({
      ...item,
      collapsed: this.viewerState.isCollapsed(
        document.uri.toString(),
        item.noteId,
        item.collapsed,
      ),
    }));

    return this.renderer.render(document, items);
  }

  public toggleNote(noteId: string, documentUri?: string): void {
    this.toggleNotes([noteId], documentUri);
  }

  public toggleNotes(noteIds: string[], documentUri?: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const editorUri = editor.document.uri.toString();
    if (documentUri && documentUri !== editorUri) {
      return;
    }

    const items = buildNoteViewerItems(
      this.store.notesForDocument(editor.document),
      getConfiguredDefaultState(),
    );
    const selected = items.filter((item) => noteIds.includes(item.noteId));

    if (selected.length === 0) {
      return;
    }

    const current = selected.map((item) =>
      this.viewerState.isCollapsed(editorUri, item.noteId, item.collapsed),
    );
    const collapse = current.some((collapsed) => !collapsed);

    for (const item of selected) {
      this.viewerState.set(editorUri, item.noteId, collapse);
    }

    this.refresh();
  }

  public clear(_editor = vscode.window.activeTextEditor): void {
    this.refresh();
  }

  public clearAll(): void {
    this.viewerState.clear();
    this.refresh();
  }

  public dispose(): void {
    this.providerRegistration?.dispose();
    this.providerRegistration = undefined;
    this.configListener.dispose();
    this.closeDocumentListener.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
    this.renderer.dispose();
  }
}
