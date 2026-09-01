import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { getVaultRoot, tryGetWorkspaceRoot } from '../../utils/file';

export function isTrackedSourceRename(
  workspaceRoot: string,
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
): boolean {
  const oldRelative = path.relative(workspaceRoot, oldUri.fsPath);
  const newRelative = path.relative(workspaceRoot, newUri.fsPath);

  if (
    oldRelative.startsWith('..') ||
    newRelative.startsWith('..') ||
    path.isAbsolute(oldRelative) ||
    path.isAbsolute(newRelative)
  ) {
    return false;
  }

  const vaultRoot = getVaultRoot(workspaceRoot);
  const oldVaultRelative = path.relative(vaultRoot, oldUri.fsPath);
  const newVaultRelative = path.relative(vaultRoot, newUri.fsPath);

  if (
    (!oldVaultRelative.startsWith('..') && !path.isAbsolute(oldVaultRelative)) ||
    (!newVaultRelative.startsWith('..') && !path.isAbsolute(newVaultRelative))
  ) {
    return false;
  }

  return true;
}

export function registerSourceRenameHandler(
  context: vscode.ExtensionContext,
  cliClient: CliClient,
  isEnabled: () => boolean,
  invalidateViews: () => Promise<void>,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles(async (event) => {
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

      try {
        const result = await cliClient.sync(workspaceRoot);

        if (result.notes_synced || result.repairs_applied > 0) {
          await invalidateViews();
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to repair notes after rename.';

        void vscode.window.showWarningMessage(message);
      }
    }),
  );
}
