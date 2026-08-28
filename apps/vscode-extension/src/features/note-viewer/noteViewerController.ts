/**
 * Coordinates note viewer rendering with the current-file notes store.
 *
 * 현재 파일 notes store와 note viewer 렌더링을 조정합니다.
 */
import * as vscode from 'vscode';

import type { CurrentFileNotesStore } from '../current-file/store';
import { buildNoteViewerItems, toggleItemCollapsed, type NoteViewerItem } from './noteViewerModel';
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
  private items: NoteViewerItem[] = [];
  private previousEditor: vscode.TextEditor | undefined;
  private readonly configListener: vscode.Disposable;

  public constructor(
    private readonly store: CurrentFileNotesStore,
    private readonly isEnabled: () => boolean = () => true,
  ) {
    this.renderer = new NoteViewerRenderer();
    this.viewerState = new NoteViewerState();
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('frilvault.noteViewer')
      ) {
        void this.refresh();
      }
    });
  }

  public async refresh(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!this.isEnabled() || !isNoteViewerEnabled()) {
      this.clear(editor);
      return;
    }

    if (this.previousEditor && this.previousEditor !== editor) {
      this.renderer.clear(this.previousEditor);
    }

    if (!editor || editor.document.uri.scheme !== 'file') {
      this.previousEditor = editor;
      return;
    }

    const snapshot = this.store.getSnapshot();
    const editorUri = editor.document.uri.toString();

    if (snapshot.loading || snapshot.editorDocumentUri !== editorUri) {
      this.renderer.clear(editor);
      this.previousEditor = editor;
      return;
    }

    const defaultState = getConfiguredDefaultState();
    const rawItems = buildNoteViewerItems(snapshot.notes, defaultState);

    // Apply persisted collapse/expand state
    this.items = rawItems.map((item) => ({
      ...item,
      collapsed: this.viewerState.isCollapsed(editorUri, item.noteId, item.collapsed),
    }));

    this.renderer.render(editor, this.items);
    this.previousEditor = editor;
  }

  public toggleNote(noteId: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const editorUri = editor.document.uri.toString();
    const item = this.items.find((i) => i.noteId === noteId);

    if (item) {
      this.viewerState.toggle(editorUri, noteId, item.collapsed);
    }

    this.items = toggleItemCollapsed(this.items, noteId);
    this.renderer.render(editor, this.items);
  }

  public clear(editor = vscode.window.activeTextEditor): void {
    this.renderer.clear(editor);
    this.items = [];
    this.previousEditor = editor;
  }

  public clearAll(): void {
    this.clear();
    this.viewerState.clear();
  }

  public dispose(): void {
    this.configListener.dispose();
    this.renderer.dispose();
  }
}
