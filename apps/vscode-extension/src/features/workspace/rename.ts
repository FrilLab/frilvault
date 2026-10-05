import * as vscode from 'vscode';

import { tryGetWorkspaceRoot } from '../../utils/file';
import { isTrackedSourcePath } from './watcher';

export function isTrackedSourceRename(
  workspaceRoot: string,
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
): boolean {
  return isTrackedSourcePath(workspaceRoot, oldUri)
    && isTrackedSourcePath(workspaceRoot, newUri);
}

export function registerSourceRenameHandler(
  context: vscode.ExtensionContext,
  isEnabled: () => boolean,
  syncSourceChanges: (trigger?: string) => void,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      if (!isEnabled()) {
        return;
      }

      const workspaceRoot = tryGetWorkspaceRoot();

      if (!workspaceRoot) {
        return;
      }

      const hasSourceRename = event.files.some(({ oldUri, newUri }) =>
        isTrackedSourceRename(workspaceRoot, oldUri, newUri),
      );

      if (!hasSourceRename) {
        return;
      }

      syncSourceChanges('source-rename');
    }),
  );
}
