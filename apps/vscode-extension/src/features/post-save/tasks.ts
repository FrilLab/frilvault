import * as vscode from 'vscode';

import {
  initializeLocalVault,
  type LocalVaultInitializationDependencies,
} from '../initialization/localVault';

export function formatOptionalPostSaveFailure(action: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `FrilVault note saved, but ${action} failed: ${detail}`;
}

export async function runOptionalPostSaveTasks(
  dependencies: LocalVaultInitializationDependencies,
  showWarningMessage: (
    message: string,
  ) => Thenable<string | undefined> = vscode.window.showWarningMessage,
): Promise<void> {
  try {
    await initializeLocalVault(dependencies);
  } catch (error) {
    await showWarningMessage(formatOptionalPostSaveFailure('local vault initialization', error));
  }
}
