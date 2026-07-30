import * as vscode from 'vscode';

const DEFAULT_MAX_PREVIEW_LINES = 3;
const DEFAULT_STATE = 'collapsed';

export type NoteViewerDefaultState = 'collapsed' | 'expanded';

export function isNoteViewerEnabled(): boolean {
  return vscode.workspace.getConfiguration('frilvault').get<boolean>('noteViewer.enabled', true);
}

export function getNoteViewerDefaultState(): NoteViewerDefaultState {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<string>('noteViewer.defaultState', DEFAULT_STATE);

  return configured === 'expanded' ? 'expanded' : 'collapsed';
}

export function getNoteViewerMaxPreviewLines(): number {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<number>('noteViewer.maxPreviewLines', DEFAULT_MAX_PREVIEW_LINES);

  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_MAX_PREVIEW_LINES;
  }

  return Math.floor(configured);
}
