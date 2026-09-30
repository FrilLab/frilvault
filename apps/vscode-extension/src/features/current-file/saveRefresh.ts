import type * as vscode from 'vscode';

export function isActiveEditorDocumentSave(
  document: vscode.TextDocument,
  activeEditor: vscode.TextEditor | undefined,
): boolean {
  return activeEditor?.document.uri.toString() === document.uri.toString();
}
