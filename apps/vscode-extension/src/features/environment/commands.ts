import * as vscode from 'vscode';

import { CliClient } from '../../core/cliClient';
import type {
  EnvironmentProfileStatus,
  EnvironmentProfilesResult,
} from '../../types';
import {
  EnvironmentDotenvItem,
  EnvironmentProfileItem,
  EnvironmentVariableItem,
} from './view';
import type { EnvironmentRuntimeState } from './provider';

export interface EnvironmentCommandDependencies {
  cliClient: CliClient;
  getWorkspaceRoot: () => string;
  refresh: () => void;
  setRuntimeState: (state: EnvironmentRuntimeState) => void;
  discoverDotenv: () => Promise<string[]>;
  showErrorMessage: (message: string) => Thenable<string | undefined>;
  showInformationMessage: (message: string) => Thenable<string | undefined>;
  showWarningMessage: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
}

export function createAddEnvironmentVariableCommand(
  dependencies: EnvironmentCommandDependencies,
): () => Promise<void> {
  return async () => {
    try {
      const profiles = await loadProfiles(dependencies);
      const profile = await pickProfile(profiles.profiles);
      if (!profile) {
        return;
      }

      const missing = profile.variables.filter(
        (variable) => variable.status === 'missing' || variable.status === 'default',
      );
      const variable = await vscode.window.showQuickPick(
        missing.map((item) => ({
          label: item.name,
          description: `${item.required ? 'required' : 'optional'} · ${item.secret ? 'secret' : 'plain'}`,
          item,
        })),
        { placeHolder: `Choose a variable to add to ${profile.profile}` },
      );
      if (!variable) {
        await dependencies.showInformationMessage(
          'No missing manifest variables are available. Define the key in the Env manifest before adding it.',
        );
        return;
      }

      await setVariable(dependencies, profile.profile, variable.item.name, variable.item.secret);
    } catch (error) {
      await dependencies.showErrorMessage(errorMessage(error, 'Failed to add environment variable.'));
    }
  };
}

export function createReplaceEnvironmentValueCommand(
  dependencies: EnvironmentCommandDependencies,
): (item?: EnvironmentVariableItem) => Promise<void> {
  return async (item) => {
    if (!item) {
      await dependencies.showErrorMessage('Select an environment variable to replace.');
      return;
    }

    try {
      await setVariable(dependencies, item.profile, item.variable.name, item.variable.secret);
    } catch (error) {
      await dependencies.showErrorMessage(errorMessage(error, 'Failed to replace environment value.'));
    }
  };
}

export function createImportEnvironmentCommand(
  dependencies: EnvironmentCommandDependencies,
): (item?: EnvironmentDotenvItem) => Promise<void> {
  return async (item) => {
    try {
      const source = item?.filePath ?? (await pickDotenv(dependencies));
      if (!source) {
        return;
      }

      const profiles = await loadProfiles(dependencies);
      const profile = await pickProfile(profiles.profiles, item?.probableProfile);
      if (!profile) {
        return;
      }

      const replace = profile.variables.some((variable) => variable.status === 'configured');
      if (replace || profile.profile.toLowerCase() === 'production') {
        const production = profile.profile.toLowerCase() === 'production';
        const confirmation = await dependencies.showWarningMessage(
          production
            ? `Replace every value in production profile '${profile.profile}' with keys from the selected dotenv file? Missing keys will be removed.`
            : `Replace every configured value in '${profile.profile}' with keys from the selected dotenv file? Missing keys will be removed.`,
          'Replace Profile',
          'Cancel',
        );
        if (confirmation !== 'Replace Profile') {
          return;
        }
      }

      await dependencies.cliClient.importEnvironment({
        workspaceRoot: dependencies.getWorkspaceRoot(),
        source,
        profile: profile.profile,
        replace,
      });
      dependencies.refresh();
      await dependencies.showInformationMessage(
        `Imported dotenv keys into '${profile.profile}'. The source file was not modified.`,
      );
    } catch (error) {
      await dependencies.showErrorMessage(errorMessage(error, 'Failed to import dotenv file.'));
    }
  };
}

export function createRunEnvironmentCommand(
  dependencies: EnvironmentCommandDependencies,
): (item?: EnvironmentProfileItem) => Promise<void> {
  return async (item) => {
    let profiles: EnvironmentProfilesResult;
    try {
      profiles = await loadProfiles(dependencies);
    } catch (error) {
      await dependencies.showErrorMessage(errorMessage(error, 'Failed to load environment profiles.'));
      return;
    }
    const selected = item?.status ?? (await pickProfile(profiles.profiles));
    if (!selected) {
      return;
    }

    const commandText = await vscode.window.showInputBox({
      prompt: `Command for '${selected.profile}' (no shell syntax; e.g. npm run dev)`,
      placeHolder: 'npm run dev',
      ignoreFocusOut: true,
    });
    if (!commandText) {
      return;
    }

    let command: string[];
    try {
      command = parseCommandLine(commandText);
    } catch (error) {
      await dependencies.showErrorMessage(errorMessage(error, 'Invalid child command.'));
      return;
    }

    dependencies.setRuntimeState({ status: 'unknown' });
    try {
      await dependencies.cliClient.runEnvironment({
        workspaceRoot: dependencies.getWorkspaceRoot(),
        profile: selected.profile,
        command,
        onSpawn: () => {
          dependencies.setRuntimeState({ status: 'confirmed', profile: selected.profile });
          dependencies.refresh();
        },
      });
      await dependencies.showInformationMessage(
        `FrilVault run completed for '${selected.profile}'.`,
      );
    } catch (error) {
      await dependencies.showErrorMessage(errorMessage(error, 'FrilVault run failed.'));
    } finally {
      dependencies.setRuntimeState({ status: 'unknown' });
      dependencies.refresh();
    }
  };
}

export function createRefreshEnvironmentCommand(refresh: () => void): () => void {
  return refresh;
}

async function setVariable(
  dependencies: EnvironmentCommandDependencies,
  profile: string,
  key: string,
  secret: boolean,
): Promise<void> {
  if (profile.toLowerCase() === 'production') {
    const confirmation = await dependencies.showWarningMessage(
      `Replace '${key}' in production profile '${profile}'? The value will never be shown.`,
      'Continue',
      'Cancel',
    );
    if (confirmation !== 'Continue') {
      return;
    }
  }

  const value = await vscode.window.showInputBox({
    prompt: `Value for ${key} in ${profile}`,
    password: secret,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }

  await dependencies.cliClient.setEnvironmentValue({
    workspaceRoot: dependencies.getWorkspaceRoot(),
    profile,
    key,
    value,
  });
  dependencies.refresh();
  await dependencies.showInformationMessage(`Updated '${key}' in '${profile}'.`);
}

async function loadProfiles(
  dependencies: EnvironmentCommandDependencies,
): Promise<EnvironmentProfilesResult> {
  return dependencies.cliClient.environmentProfiles(dependencies.getWorkspaceRoot());
}

async function pickProfile(
  profiles: EnvironmentProfileStatus[],
  preferred?: string,
): Promise<EnvironmentProfileStatus | undefined> {
  if (preferred) {
    const match = profiles.find((profile) => profile.profile === preferred);
    if (match) {
      return match;
    }
  }

  return vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.profile,
      description: profile.status,
      profile,
    })),
    { placeHolder: 'Select an environment profile' },
  ).then((pick) => pick?.profile);
}

async function pickDotenv(
  dependencies: EnvironmentCommandDependencies,
): Promise<string | undefined> {
  const files = await dependencies.discoverDotenv();
  if (files.length === 0) {
    await dependencies.showInformationMessage('No project dotenv files were discovered.');
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    files.map((filePath) => ({ label: filePath, filePath })),
    { placeHolder: 'Choose a dotenv file to import explicitly' },
  );
  return pick?.filePath;
}

export function parseCommandLine(input: string): string[] {
  if (/[|;&`$]/.test(input)) {
    throw new Error('Shell syntax is not supported. Enter an executable and arguments directly.');
  }

  const parts: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }

  if (parts.length === 0) {
    throw new Error('A child executable is required.');
  }

  return parts;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
