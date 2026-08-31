import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { getVaultRoot, tryGetWorkspaceRoot } from '../../utils/file';

const SYNC_DEBOUNCE_MS = 300;

export function isTrackedVaultPath(workspaceRoot: string, uri: vscode.Uri): boolean {
  const relative = path.relative(getVaultRoot(workspaceRoot), uri.fsPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  return (
    relative === `notes` ||
    relative.startsWith(`notes${path.sep}`) ||
    relative === `images` ||
    relative.startsWith(`images${path.sep}`)
  );
}

export function isTrackedSourcePath(workspaceRoot: string, uri: vscode.Uri): boolean {
  const relative = path.relative(workspaceRoot, uri.fsPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const relativeVaultPath = path.relative(getVaultRoot(workspaceRoot), uri.fsPath);
  if (!relativeVaultPath.startsWith('..') && !path.isAbsolute(relativeVaultPath)) {
    return false;
  }

  return true;
}

export function registerWorkspaceWatcher(
  context: vscode.ExtensionContext,
  cliClient: CliClient,
  isEnabled: () => boolean,
  invalidateViews: () => Promise<void>,
): void {
  const workspaceRoot = tryGetWorkspaceRoot();

  if (!workspaceRoot) {
    return;
  }

  const vaultRoot = getVaultRoot(workspaceRoot);

  let debounceTimer: NodeJS.Timeout | undefined;

  const scheduleSync = () => {
    if (!isEnabled()) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      const root = tryGetWorkspaceRoot();

      if (!root) {
        return;
      }

      try {
        await cliClient.sync(root);
        await invalidateViews();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to sync workspace changes.';

        void vscode.window.showWarningMessage(message);
      }
    }, SYNC_DEBOUNCE_MS);
  };

  const notesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vaultRoot, 'notes/**'),
  );

  notesWatcher.onDidCreate(scheduleSync);
  notesWatcher.onDidChange(scheduleSync);
  notesWatcher.onDidDelete(scheduleSync);

  const imagesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vaultRoot, 'images/**'),
  );

  imagesWatcher.onDidCreate(scheduleSync);
  imagesWatcher.onDidChange(scheduleSync);
  imagesWatcher.onDidDelete(scheduleSync);

  const sourceWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '**/*'),
    false,
    true,
    false,
  );

  sourceWatcher.onDidCreate((uri) => {
    if (isTrackedSourcePath(workspaceRoot, uri)) {
      scheduleSync();
    }
  });

  sourceWatcher.onDidDelete((uri) => {
    if (isTrackedSourcePath(workspaceRoot, uri)) {
      scheduleSync();
    }
  });

  context.subscriptions.push(notesWatcher, imagesWatcher, sourceWatcher, {
    dispose: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    },
  });
}
