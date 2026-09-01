import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { getVaultRoot, tryGetWorkspaceRoot } from '../../utils/file';

const SYNC_DEBOUNCE_MS = 300;

export interface WorkspaceWatcherDependencies {
  createFileSystemWatcher?: typeof vscode.workspace.createFileSystemWatcher;
  onDidChangeConfiguration?: typeof vscode.workspace.onDidChangeConfiguration;
}

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
  dependencies: WorkspaceWatcherDependencies = {},
): void {
  let debounceTimer: NodeJS.Timeout | undefined;
  let watchers: vscode.FileSystemWatcher[] = [];
  const createFileSystemWatcher =
    dependencies.createFileSystemWatcher ??
    vscode.workspace.createFileSystemWatcher.bind(vscode.workspace);
  const onDidChangeConfiguration =
    dependencies.onDidChangeConfiguration ??
    vscode.workspace.onDidChangeConfiguration.bind(vscode.workspace);

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

  const disposeWatchers = () => {
    for (const watcher of watchers) {
      watcher.dispose();
    }
    watchers = [];
  };

  const rebindWatchers = () => {
    disposeWatchers();

    const workspaceRoot = tryGetWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const vaultRoot = getVaultRoot(workspaceRoot);
    const notesWatcher = createFileSystemWatcher(
      new vscode.RelativePattern(vaultRoot, 'notes/**'),
    );

    notesWatcher.onDidCreate(scheduleSync);
    notesWatcher.onDidChange(scheduleSync);
    notesWatcher.onDidDelete(scheduleSync);

    const imagesWatcher = createFileSystemWatcher(
      new vscode.RelativePattern(vaultRoot, 'images/**'),
    );

    imagesWatcher.onDidCreate(scheduleSync);
    imagesWatcher.onDidChange(scheduleSync);
    imagesWatcher.onDidDelete(scheduleSync);

    const sourceWatcher = createFileSystemWatcher(
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

    watchers = [notesWatcher, imagesWatcher, sourceWatcher];
  };

  rebindWatchers();

  const configurationListener = onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('frilvault.vaultPath') ||
      event.affectsConfiguration('frilvault.workspaceRoot')
    ) {
      rebindWatchers();
    }
  });

  context.subscriptions.push(
    configurationListener,
    new vscode.Disposable(() => {
      disposeWatchers();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    }),
  );
}
