import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { COMMAND_IDS } from '../../constants/ids';
import type { EnvironmentProfileStatus } from '../../types';
import {
  EnvironmentDotenvHeaderItem,
  EnvironmentDotenvItem,
  EnvironmentProfileItem,
  EnvironmentStatusItem,
  EnvironmentSummaryItem,
  EnvironmentVariableItem,
  type EnvironmentTreeNode,
} from './view';

export type EnvironmentRuntimeState =
  | { status: 'configured' | 'detected' | 'unknown'; profile?: string }
  | { status: 'confirmed'; profile: string };

export interface EnvironmentProviderDependencies {
  cliClient: CliClient;
  getWorkspaceRoot: () => string;
  isEnabled: () => boolean;
  discoverDotenv: () => Promise<string[]>;
  getRuntimeState: () => EnvironmentRuntimeState;
}

export class FrilVaultEnvironmentProvider
  implements vscode.TreeDataProvider<EnvironmentTreeNode>
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  private profiles: EnvironmentProfileStatus[] | undefined;
  private dotenvFiles: string[] | undefined;
  private loading: Promise<void> | undefined;
  private loadError: string | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(private readonly dependencies: EnvironmentProviderDependencies) {}

  public refresh(): void {
    this.profiles = undefined;
    this.dotenvFiles = undefined;
    this.loadError = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: EnvironmentTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: EnvironmentTreeNode): Promise<EnvironmentTreeNode[]> {
    if (!this.dependencies.isEnabled()) {
      return [new EnvironmentStatusItem('Disabled for this workspace.', 'debug-pause')];
    }

    if (element instanceof EnvironmentProfileItem) {
      return element.status.variables.map(
        (variable) =>
          new EnvironmentVariableItem(element.status.profile, element.status.scope, variable),
      );
    }

    if (element instanceof EnvironmentDotenvHeaderItem) {
      return this.dotenvItems();
    }

    if (element) {
      return [];
    }

    await this.ensureLoaded();

    if (this.loadError) {
      return [new EnvironmentStatusItem(this.loadError, 'error')];
    }

    const runtime = this.dependencies.getRuntimeState();
    const selectedProfile = runtime.profile ?? this.profiles?.[0]?.profile;
    const runtimeStatus =
      runtime.status === 'unknown' &&
      this.profiles?.some((profile) => profile.status === 'ready')
        ? 'configured'
        : runtime.status;
    const children: EnvironmentTreeNode[] = [
      new EnvironmentSummaryItem(
        selectedProfile,
        runtimeStatus,
        {
          command: COMMAND_IDS.environmentRun,
          title: 'Run with Environment Profile',
        },
      ),
    ];

    if (!this.profiles || this.profiles.length === 0) {
      children.push(
        new EnvironmentStatusItem(
          'No encrypted profiles found. Initialize Env and create a profile through the CLI.',
          'info',
        ),
      );
    } else {
      children.push(...this.profiles.map((profile) => new EnvironmentProfileItem(profile)));
    }

    children.push(new EnvironmentDotenvHeaderItem());
    return children;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.profiles && this.dotenvFiles) {
      return;
    }

    if (!this.loading) {
      this.loading = Promise.all([
        this.dependencies.cliClient.environmentProfiles(this.dependencies.getWorkspaceRoot()),
        this.dependencies.discoverDotenv(),
      ])
        .then(([profiles, dotenvFiles]) => {
          this.profiles = profiles.profiles;
          this.dotenvFiles = dotenvFiles;
          this.loadError = undefined;
        })
        .catch((error: unknown) => {
          this.loadError = error instanceof Error ? error.message : 'Failed to load environments.';
        })
        .finally(() => {
          this.loading = undefined;
          this.onDidChangeTreeDataEmitter.fire();
        });
    }

    await this.loading;
  }

  private dotenvItems(): EnvironmentDotenvItem[] {
    const workspaceRoot = this.dependencies.getWorkspaceRoot();
    return (this.dotenvFiles ?? []).map(
      (filePath) =>
        new EnvironmentDotenvItem(filePath, probableProfile(filePath), workspaceRoot),
    );
  }
}

export function probableProfile(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  if (name === '.env') {
    return 'development';
  }

  return name.startsWith('.env.') ? name.slice('.env.'.length) || 'development' : 'unknown';
}
