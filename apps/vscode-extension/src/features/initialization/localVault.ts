import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { getVaultRoot } from '../../utils/file';

export interface LocalVaultInitializationDependencies {
  getWorkspaceRoot: () => string;
  cliClient: CliClient;
  showWarningMessage?: (message: string) => Thenable<string | undefined>;
}

export async function initializeLocalVault(
  dependencies: LocalVaultInitializationDependencies,
): Promise<void> {
  const result = await dependencies.cliClient.initializeLocal(
    dependencies.getWorkspaceRoot(),
  );

  if (result.git_exclude !== 'vault_tracked') {
    return;
  }

  const showWarningMessage =
    dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
  const workspaceRoot = dependencies.getWorkspaceRoot();
  const vaultRoot = getVaultRoot(workspaceRoot);
  const relativeVaultRoot = path.relative(workspaceRoot, vaultRoot);
  const vaultPath =
    relativeVaultRoot.length > 0 &&
    !relativeVaultRoot.startsWith('..') &&
    !path.isAbsolute(relativeVaultRoot)
      ? relativeVaultRoot.split(path.sep).join('/')
      : vaultRoot;

  await showWarningMessage(
    `The selected vault (${vaultPath}) is already tracked by Git. Local exclude rules do not affect tracked files. To stop tracking it, run: git rm -r --cached ${vaultPath}`,
  );
}
