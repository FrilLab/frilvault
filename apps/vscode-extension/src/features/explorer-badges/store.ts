import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import type { IndexedFile } from '../../types';
import { normalizeWorkspaceRelativePath } from '../../utils/file';

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

  private readonly onDidChangeEmitter = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(
    private readonly cliClient: CliClient,
    private readonly getWorkspaceRoot: () => string,
  ) {}

  public getFileCount(relativePath: string): number | undefined {
    return this.fileCounts.get(relativePath);
  }

  public getFolderCount(relativePath: string): number | undefined {
    return this.folderCounts.get(relativePath);
  }

  public listIndexedFiles(): IndexedFile[] {
    return [...this.fileCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source_file, note_count]) => ({
        source_file,
        note_count,
        exists: true,
      }));
  }

  public async reload(): Promise<void> {
    const index = await this.cliClient.workspaceIndex(this.getWorkspaceRoot());

    this.fileCounts.clear();

    for (const file of index.files) {
      if (file.note_count <= 0) {
        continue;
      }

      this.fileCounts.set(normalizeWorkspaceRelativePath(file.source_file), file.note_count);
    }

    this.rebuildFolderCounts();
    this.onDidChangeEmitter.fire(undefined);
  }

  public clear(): void {
    this.fileCounts.clear();
    this.folderCounts.clear();
    this.onDidChangeEmitter.fire(undefined);
  }

  public refreshPresentation(): void {
    this.rebuildFolderCounts();
    this.onDidChangeEmitter.fire(undefined);
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  private rebuildFolderCounts(): void {
    this.folderCounts.clear();

    if (!isExplorerFolderAggregationEnabled()) {
      return;
    }

    for (const [sourceFile, count] of this.fileCounts) {
      const segments = sourceFile.split('/');

      for (let index = 1; index < segments.length; index += 1) {
        const folderPath = segments.slice(0, index).join('/');
        this.folderCounts.set(folderPath, (this.folderCounts.get(folderPath) ?? 0) + count);
      }
    }
  }
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
