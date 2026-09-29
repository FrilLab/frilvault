import * as vscode from 'vscode';

import {
  CliClient,
  CliCommandError,
  isWorkspaceNotFoundError,
} from '../../core/cliClient';
import { initializeLocalVault } from '../initialization/localVault';
import type { WorkspaceStatus } from '../../types';
import {
  isFrilVaultEnabled,
  setFrilVaultEnabled,
  syncEnabledContext,
} from './state';

const INITIALIZATION_CHOICES = [
  'Initialize Local Vault',
  'Initialize Shared Vault',
  'Choose Existing/External Vault',
  'Cancel',
] as const;

export interface EnablementCommandDependencies {
  getWorkspaceRoot: () => string;
  workspaceState: vscode.Memento;
  cliClient: CliClient;
  onVaultResolved?: () => Promise<void>;
  refreshUi: () => Promise<void>;
  clearUi: () => void;
  showInformationMessage?: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  showWarningMessage?: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  showErrorMessage?: (message: string) => Thenable<string | undefined>;
  showOpenDialog?: typeof vscode.window.showOpenDialog;
  getWorkspaceVaultPath?: () => string | undefined;
  updateWorkspaceVaultPath?: (path: string | undefined) => Promise<void>;
}

export function createEnableCommand(
  dependencies: EnablementCommandDependencies,
): () => Promise<void> {
  return async () => {
    const workspaceRoot = dependencies.getWorkspaceRoot();
    const alreadyEnabled = isFrilVaultEnabled(dependencies.workspaceState, workspaceRoot);
    let status: WorkspaceStatus;
    try {
      status = await dependencies.cliClient.workspaceStatus(workspaceRoot);
    } catch (error) {
      if (!isWorkspaceNotFoundError(error)) {
        if (alreadyEnabled && isInvalidWorkspaceStateError(error)) {
          await setFrilVaultEnabled(dependencies.workspaceState, workspaceRoot, false);
          await syncEnabledContext(false);
          dependencies.clearUi();
        }
        await showError(dependencies, error);
        return;
      }

      if (alreadyEnabled) {
        await setFrilVaultEnabled(dependencies.workspaceState, workspaceRoot, false);
        await syncEnabledContext(false);
        dependencies.clearUi();
        await showError(
          dependencies,
          new Error(
            `${error.message} FrilVault was disabled for this workspace. Run Enable to choose an initialization option.`,
          ),
        );
        return;
      }

      const showInformationMessage =
        dependencies.showInformationMessage ?? vscode.window.showInformationMessage;
      const choice = await showInformationMessage(
        'No initialized FrilVault vault was found. Local stores data in this Git checkout; Shared stores it in the project-root .vault/.',
        ...INITIALIZATION_CHOICES,
      );

      if (choice === 'Initialize Local Vault') {
        try {
          await initializeLocalVault({
            getWorkspaceRoot: () => workspaceRoot,
            cliClient: dependencies.cliClient,
            showWarningMessage: dependencies.showWarningMessage,
          });
          status = await dependencies.cliClient.workspaceStatus(workspaceRoot);
        } catch (initializationError) {
          await showError(dependencies, initializationError);
          return;
        }
      } else if (choice === 'Initialize Shared Vault') {
        try {
          await dependencies.cliClient.initializeShared(workspaceRoot);
          status = await dependencies.cliClient.workspaceStatus(workspaceRoot);
        } catch (initializationError) {
          await showError(dependencies, initializationError);
          return;
        }
      } else if (choice === 'Choose Existing/External Vault') {
        const configuration = vscode.workspace.getConfiguration('frilvault');
        const getWorkspaceVaultPath =
          dependencies.getWorkspaceVaultPath ??
          (() => configuration.inspect<string>('vaultPath')?.workspaceValue);
        const updateWorkspaceVaultPath = dependencies.updateWorkspaceVaultPath ??
          ((path: string | undefined) =>
            configuration.update('vaultPath', path, vscode.ConfigurationTarget.Workspace));
        const previousWorkspaceVaultPath = getWorkspaceVaultPath();
        let changedVaultPath = false;
        try {
          const showOpenDialog = dependencies.showOpenDialog ?? vscode.window.showOpenDialog;
          const selected = await showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Use FrilVault Vault',
            title: 'Choose an existing FrilVault vault directory',
          });
          if (!selected?.[0]) {
            return;
          }

          await updateWorkspaceVaultPath(selected[0].fsPath);
          changedVaultPath = true;
          status = await dependencies.cliClient.workspaceStatus(workspaceRoot);
        } catch (validationError) {
          if (changedVaultPath) {
            await updateWorkspaceVaultPath(previousWorkspaceVaultPath);
          }
          await showError(dependencies, validationError);
          return;
        }
      } else {
        return;
      }
    }

    if (status.mode === 'local' && status.git_tracking === 'trackable') {
      const showWarningMessage =
        dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
      const choice = await showWarningMessage(
        `The Local Vault at ${status.vault_path} is trackable by Git. Repair its repository-local exclusion before enabling FrilVault?`,
        'Repair Local Exclusion',
        'Enable Without Repair',
        'Cancel',
      );

      if (choice === 'Cancel' || choice === undefined) {
        return;
      }
      if (choice === 'Repair Local Exclusion') {
        try {
          await initializeLocalVault({
            getWorkspaceRoot: () => workspaceRoot,
            cliClient: dependencies.cliClient,
            showWarningMessage: dependencies.showWarningMessage,
          });
          status = await dependencies.cliClient.workspaceStatus(workspaceRoot);
        } catch (repairError) {
          await showError(dependencies, repairError);
          return;
        }
      }
    } else if (status.mode === 'local' && status.git_tracking === 'tracked') {
      const showWarningMessage =
        dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
      const choice = await showWarningMessage(
        `The Local Vault at ${status.vault_path} is already tracked by Git. Exclude rules cannot untrack files; run git rm -r --cached manually if you want to stop tracking it.`,
        'Enable',
        'Cancel',
      );
      if (choice !== 'Enable') {
        return;
      }
    }

    if (alreadyEnabled) {
      return;
    }

    await dependencies.onVaultResolved?.();
    await setFrilVaultEnabled(dependencies.workspaceState, workspaceRoot, true);
    await syncEnabledContext(true);
    await dependencies.refreshUi();

    const showInformationMessage =
      dependencies.showInformationMessage ?? vscode.window.showInformationMessage;
    await showInformationMessage('FrilVault enabled for this workspace.');
  };
}

function isInvalidWorkspaceStateError(error: unknown): boolean {
  return (
    error instanceof CliCommandError &&
    ['incomplete_workspace', 'invalid_workspace_metadata'].includes(error.code ?? '')
  );
}

export function createDisableCommand(
  dependencies: EnablementCommandDependencies,
): () => Promise<void> {
  return async () => {
    const workspaceRoot = dependencies.getWorkspaceRoot();

    if (!isFrilVaultEnabled(dependencies.workspaceState, workspaceRoot)) {
      return;
    }

    await setFrilVaultEnabled(dependencies.workspaceState, workspaceRoot, false);
    await syncEnabledContext(false);
    dependencies.clearUi();

    const showInformationMessage =
      dependencies.showInformationMessage ?? vscode.window.showInformationMessage;

    await showInformationMessage('FrilVault disabled for this workspace.');
  };
}

async function showError(
  dependencies: EnablementCommandDependencies,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const showErrorMessage = dependencies.showErrorMessage ?? vscode.window.showErrorMessage;
  await showErrorMessage(message);
}
