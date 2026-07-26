import * as vscode from 'vscode';

import { tryGetRelativeFilePath } from '../../utils/file';
import {
  explorerNoteCountTooltip,
  formatExplorerNoteCountBadge,
  isExplorerFolderAggregationEnabled,
  isExplorerNoteCountsEnabled,
  WorkspaceNoteCountStore,
} from './store';

export function registerExplorerNoteCountDecorations(
  context: vscode.ExtensionContext,
  store: WorkspaceNoteCountStore,
  getWorkspaceRoot: () => string,
  isEnabled: () => boolean,
): vscode.Disposable {
  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: store.onDidChange,
    provideFileDecoration(uri) {
      if (!isEnabled() || !isExplorerNoteCountsEnabled() || uri.scheme !== 'file') {
        return undefined;
      }

      let workspaceRoot: string;

      try {
        workspaceRoot = getWorkspaceRoot();
      } catch {
        return undefined;
      }

      const relativePath = tryGetRelativeFilePath(workspaceRoot, uri.fsPath);

      if (!relativePath) {
        return undefined;
      }

      const fileCount = store.getFileCount(relativePath);

      if (fileCount && fileCount > 0) {
        return {
          badge: formatExplorerNoteCountBadge(fileCount),
          tooltip: explorerNoteCountTooltip(fileCount),
        };
      }

      if (!isExplorerFolderAggregationEnabled()) {
        return undefined;
      }

      const folderCount = store.getFolderCount(relativePath);

      if (!folderCount || folderCount <= 0) {
        return undefined;
      }

      return {
        badge: formatExplorerNoteCountBadge(folderCount),
        tooltip: explorerNoteCountTooltip(folderCount),
      };
    },
  };

  const registration = vscode.window.registerFileDecorationProvider(provider);

  context.subscriptions.push(
    registration,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('frilvault.explorerNoteCounts.enabled')
        || event.affectsConfiguration('frilvault.explorerNoteCounts.folderAggregation')
      ) {
        store.refreshPresentation();
      }
    }),
  );

  return registration;
}
