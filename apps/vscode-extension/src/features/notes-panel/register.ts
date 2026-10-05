import * as vscode from 'vscode';

import { VIEW_IDS } from '../../constants/ids';
import { NotesFileHeaderItem } from './view';
import type { FrilVaultNotesProvider } from './provider';

let notesTreeRegistration: vscode.Disposable | undefined;

/**
 * Registers the contributed notes tree data provider exactly once per extension host.
 *
 * VS Code rejects duplicate `registerTreeDataProvider` calls for the same view id.
 * This helper is idempotent so repeated activation attempts reuse the existing
 * registration instead of throwing.
 *
 * 기여된 notes tree data provider를 extension host당 한 번만 등록합니다.
 */
export function registerNotesTreeDataProvider(
  context: vscode.ExtensionContext,
  provider: FrilVaultNotesProvider,
): vscode.Disposable {
  if (notesTreeRegistration) {
    return notesTreeRegistration;
  }

  const view = vscode.window.createTreeView(VIEW_IDS.notes, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  const collapsed = view.onDidCollapseElement(({ element }) => {
    if (element instanceof NotesFileHeaderItem) {
      provider.setFileCollapsed(element, true);
    }
  });
  const expanded = view.onDidExpandElement(({ element }) => {
    if (element instanceof NotesFileHeaderItem) {
      provider.setFileCollapsed(element, false);
    }
  });
  notesTreeRegistration = new vscode.Disposable(() => {
    collapsed.dispose();
    expanded.dispose();
    view.dispose();
  });

  context.subscriptions.push({
    dispose: () => {
      disposeNotesTreeDataProvider();
    },
  });

  return notesTreeRegistration;
}

/** Disposes the notes tree registration and clears module state. */
export function disposeNotesTreeDataProvider(): void {
  notesTreeRegistration?.dispose();
  notesTreeRegistration = undefined;
}

/** Returns whether the notes tree provider is currently registered. */
export function isNotesTreeDataProviderRegistered(): boolean {
  return notesTreeRegistration !== undefined;
}

/** Clears registration state between unit tests. */
export function resetNotesTreeRegistrationForTests(): void {
  disposeNotesTreeDataProvider();
}
