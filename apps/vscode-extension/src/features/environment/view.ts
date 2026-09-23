import * as vscode from 'vscode';
import * as path from 'node:path';

import { COMMAND_IDS, VIEW_ITEM_CONTEXT } from '../../constants/ids';
import type {
  EnvironmentProfileStatus,
  EnvironmentVariableStatus,
} from '../../types';

export class EnvironmentStatusItem extends vscode.TreeItem {
  public constructor(message: string, icon: string = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = VIEW_ITEM_CONTEXT.environmentStatus;
  }
}

export class EnvironmentSummaryItem extends vscode.TreeItem {
  public constructor(
    selectedProfile: string | undefined,
    runtimeStatus: string,
    onRun: vscode.Command,
  ) {
    super('Environment status', vscode.TreeItemCollapsibleState.None);
    this.description = selectedProfile
      ? `next run: ${selectedProfile} · ${runtimeStatus}`
      : `next run: not selected · ${runtimeStatus}`;
    this.iconPath = new vscode.ThemeIcon('symbol-property');
    this.command = onRun;
    this.tooltip =
      'Profile selection is local to FrilVault. Runtime is Confirmed only while FrilVault launched the child process.';
    this.contextValue = VIEW_ITEM_CONTEXT.environmentStatus;
  }
}

export class EnvironmentProfileItem extends vscode.TreeItem {
  public constructor(public readonly status: EnvironmentProfileStatus) {
    super(status.profile, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = status.status;
    this.iconPath = new vscode.ThemeIcon(profileIcon(status.status));
    this.contextValue = VIEW_ITEM_CONTEXT.environmentProfile;
    this.command = {
      command: COMMAND_IDS.environmentRun,
      title: 'Run with Environment Profile',
      arguments: [this],
    };
  }
}

export class EnvironmentVariableItem extends vscode.TreeItem {
  public constructor(
    public readonly profile: string,
    public readonly scope: EnvironmentProfileStatus['scope'],
    public readonly variable: EnvironmentVariableStatus,
  ) {
    super(variable.name, vscode.TreeItemCollapsibleState.None);
    this.description = [
      variable.status,
      variable.required ? 'required' : 'optional',
      variable.secret ? 'secret' : 'plain',
      variable.source,
      scope,
    ].join(' · ');
    this.tooltip = variable.description
      ? `${variable.name}: ${variable.description}`
      : `${variable.name} (${variable.status})`;
    this.iconPath = new vscode.ThemeIcon(variable.secret ? 'lock' : 'symbol-property');
    this.contextValue = VIEW_ITEM_CONTEXT.environmentVariable;
    this.command = {
      command: COMMAND_IDS.environmentReplaceValue,
      title: 'Replace Environment Value',
      arguments: [this],
    };
  }
}

export class EnvironmentDotenvHeaderItem extends vscode.TreeItem {
  public constructor() {
    super('Discovered dotenv files', vscode.TreeItemCollapsibleState.Expanded);
    this.description = 'not imported automatically';
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = VIEW_ITEM_CONTEXT.environmentStatus;
  }
}

export class EnvironmentDotenvItem extends vscode.TreeItem {
  public constructor(
    public readonly filePath: string,
    public readonly probableProfile: string,
    workspaceRoot: string,
  ) {
    super(path.relative(workspaceRoot, filePath) || path.basename(filePath));
    this.description = `${probableProfile} · import explicitly`;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = VIEW_ITEM_CONTEXT.environmentDotenv;
    this.command = {
      command: COMMAND_IDS.environmentImport,
      title: 'Import Dotenv File',
      arguments: [this],
    };
    this.tooltip =
      'This file was discovered by filename convention. FrilVault will not read or import it until you choose Import.';
  }
}

export type EnvironmentTreeNode =
  | EnvironmentStatusItem
  | EnvironmentSummaryItem
  | EnvironmentProfileItem
  | EnvironmentVariableItem
  | EnvironmentDotenvHeaderItem
  | EnvironmentDotenvItem;

function profileIcon(status: EnvironmentProfileStatus['status']): string {
  switch (status) {
    case 'ready':
      return 'check';
    case 'missing':
      return 'warning';
    case 'invalid':
      return 'error';
    case 'unavailable':
      return 'question';
  }
}
