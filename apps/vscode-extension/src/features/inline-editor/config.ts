import * as vscode from 'vscode';

const DEFAULT_DEBOUNCE_MS = 900;

export function getInlineNotesDebounceMs(): number {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<number>('inlineEditor.autoSaveDebounceMs', DEFAULT_DEBOUNCE_MS);

  if (!Number.isFinite(configured) || configured < 100) {
    return DEFAULT_DEBOUNCE_MS;
  }

  return Math.floor(configured);
}
