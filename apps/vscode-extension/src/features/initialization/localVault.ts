import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';

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
  await showWarningMessage(
    '.vault is already tracked by Git. Local exclude rules do not affect tracked files. To stop tracking it, run: git rm -r --cached .vault',
  );
}
