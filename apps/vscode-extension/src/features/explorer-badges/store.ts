import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import type { WorkspaceIndex } from '../../types';
import { getVaultRoot, normalizeWorkspaceRelativePath } from '../../utils/file';
import { ContextualRefresh } from '../refresh/contextualRefresh';
import type { RefreshTraceSink } from '../refresh/diagnostics';
import { workspaceVaultContextKey } from '../refresh/contextIdentity';

export function isExplorerNoteCountsEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('frilvault')
    .get<boolean>('explorerNoteCounts.enabled', true);
}

export function isExplorerFolderAggregationEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('frilvault')
    .get<boolean>('explorerNoteCounts.folderAggregation', true);
}

export class WorkspaceNoteCountStore implements vscode.Disposable {
  private fileCounts = new Map<string, number>();

  private folderCounts = new Map<string, number>();

  private contextKey: string | undefined;

  private lastError: { contextKey: string; error: unknown } | undefined;

  private readonly refreshScheduler: ContextualRefresh<WorkspaceIndex>;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(
    private readonly cliClient: CliClient,
    private readonly getWorkspaceRoot: () => string,
    private readonly getVaultRootForWorkspace: (workspaceRoot: string) => string = getVaultRoot,
    trace?: RefreshTraceSink,
  ) {
    this.refreshScheduler = new ContextualRefresh('workspace-note-counts', trace);
  }

  public getFileCount(relativePath: string): number | undefined {
    return this.fileCounts.get(relativePath);
  }

  public getFolderCount(relativePath: string): number | undefined {
    return this.folderCounts.get(relativePath);
  }

  public async reload(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    const vaultRoot = this.getVaultRootForWorkspace(workspaceRoot);
    const contextKey = workspaceVaultContextKey(workspaceRoot, vaultRoot);
    this.selectContext(contextKey);
    this.lastError = undefined;

    await this.refreshScheduler.run(
      contextKey,
      () => this.cliClient.workspaceIndex(workspaceRoot),
      (index) => {
        if (this.contextKey === contextKey) {
          const changed = this.applyIndex(index);
          this.lastError = undefined;
          return changed;
        }
        return false;
      },
      (error) => {
        if (this.contextKey === contextKey) {
          this.lastError = { contextKey, error };
        }
      },
      true,
      'workspace-count-refresh',
    );

    const lastError = this.readLastError();
    if (lastError?.contextKey === contextKey) {
      throw lastError.error;
    }
  }

  public clear(): void {
    this.refreshScheduler.clear();
    this.contextKey = undefined;
    this.lastError = undefined;
    const changed = this.fileCounts.size > 0 || this.folderCounts.size > 0;
    this.fileCounts.clear();
    this.folderCounts.clear();
    if (changed) {
      this.onDidChangeEmitter.fire(undefined);
    }
  }

  public refreshPresentation(): void {
    const previousFolders = this.folderCounts;
    this.folderCounts = this.buildFolderCounts(this.fileCounts);
    if (!mapsEqual(previousFolders, this.folderCounts)) {
      this.onDidChangeEmitter.fire(undefined);
    }
  }

  public dispose(): void {
    this.refreshScheduler.dispose();
    this.onDidChangeEmitter.dispose();
  }

  private buildFolderCounts(fileCounts: Map<string, number>): Map<string, number> {
    const result = new Map<string, number>();
    if (!isExplorerFolderAggregationEnabled()) {
      return result;
    }

    for (const [sourceFile, count] of fileCounts) {
      const segments = sourceFile.split('/');

      for (let index = 1; index < segments.length; index += 1) {
        const folderPath = segments.slice(0, index).join('/');
        result.set(folderPath, (result.get(folderPath) ?? 0) + count);
      }
    }
    return result;
  }

  private selectContext(contextKey: string): void {
    if (this.contextKey === contextKey) {
      return;
    }
    const changed = this.fileCounts.size > 0 || this.folderCounts.size > 0;
    this.refreshScheduler.clear();
    this.contextKey = contextKey;
    this.lastError = undefined;
    this.fileCounts.clear();
    this.folderCounts.clear();
    if (changed) {
      this.onDidChangeEmitter.fire(undefined);
    }
  }

  private readLastError(): { contextKey: string; error: unknown } | undefined {
    return this.lastError;
  }

  private applyIndex(index: WorkspaceIndex): boolean {
    const nextFileCounts = new Map<string, number>();
    for (const file of index.files) {
      if (file.note_count > 0) {
        nextFileCounts.set(normalizeWorkspaceRelativePath(file.source_file), file.note_count);
      }
    }
    const nextFolderCounts = this.buildFolderCounts(nextFileCounts);
    const changed = !mapsEqual(this.fileCounts, nextFileCounts)
      || !mapsEqual(this.folderCounts, nextFolderCounts);
    this.fileCounts = nextFileCounts;
    this.folderCounts = nextFolderCounts;
    if (changed) {
      this.onDidChangeEmitter.fire(undefined);
    }
    return changed;
  }

}

function mapsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function formatExplorerNoteCountBadge(count: number): string {
  if (count > 9) {
    return '(9+)';
  }

  return `(${count})`;
}

export function explorerNoteCountTooltip(count: number): string {
  return `${count} FrilVault note${count === 1 ? '' : 's'}`;
}
