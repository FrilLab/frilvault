import * as vscode from 'vscode';
import * as path from 'node:path';

import { COMMAND_IDS } from '../../constants/ids';
import {
  CurrentFileNotesStore,
} from '../current-file/store';
import type { WorkspaceExplorer } from '../../types';
import { getVaultRoot } from '../../utils/file';
import {
  buildWorkspaceNoteTreeFromExplorer,
  groupNotesByAnchor,
  type WorkspaceTreeNode,
} from './presentation';
import {
  NotesAnchorGroupItem,
  NotesFileHeaderItem,
  NotesPanelItem,
  NotesStatusItem,
  NotesSymbolGroupItem,
  NotesWorkspaceFileItem,
  NotesWorkspaceFolderItem,
  NotesWorkspaceOverviewItem,
} from './view';

type TreeNode =
  | NotesFileHeaderItem
  | NotesStatusItem
  | NotesSymbolGroupItem
  | NotesAnchorGroupItem
  | NotesPanelItem
  | NotesWorkspaceOverviewItem
  | NotesWorkspaceFolderItem
  | NotesWorkspaceFileItem;

export class FrilVaultNotesProvider implements vscode.TreeDataProvider<TreeNode> {
  private static readonly FILE_COLLAPSE_STATE_KEY = 'frilvault.notes.collapsedFiles.v1';
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  private readonly collapsedFiles: Record<string, boolean>;
  private workspaceOverviewLoad: Promise<void> | undefined;
  private workspaceOverviewError: string | undefined;
  private workspaceOverview: WorkspaceExplorer | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly store: CurrentFileNotesStore,
    private readonly loadWorkspaceOverview: () => Promise<WorkspaceExplorer>,
    private readonly getWorkspaceRoot: () => string,
    private readonly isEnabled: () => boolean = () => true,
    private readonly workspaceState?: vscode.Memento,
  ) {
    this.collapsedFiles = workspaceState?.get<Record<string, boolean>>(
      FrilVaultNotesProvider.FILE_COLLAPSE_STATE_KEY,
      {},
    ) ?? {};
  }

  public refresh(): void {
    this.workspaceOverview = undefined;
    this.workspaceOverviewError = undefined;
    this.notifyTreeChanged();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  public setFileCollapsed(item: NotesFileHeaderItem, collapsed: boolean): void {
    this.collapsedFiles[item.identity] = collapsed;
    void this.workspaceState?.update(
      FrilVaultNotesProvider.FILE_COLLAPSE_STATE_KEY,
      this.collapsedFiles,
    );
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!this.isEnabled()) {
      return [new NotesStatusItem('Disabled for this workspace.', 'debug-pause')];
    }

    const snapshot = this.store.getSnapshot();

    if (element instanceof NotesSymbolGroupItem || element instanceof NotesAnchorGroupItem) {
      return element.notes.map((note) => new NotesPanelItem(note, this.getWorkspaceRoot()));
    }

    if (element instanceof NotesFileHeaderItem) {
      if (
        snapshot.sourceFile !== element.sourceFile ||
        this.fileIdentity(element.sourceFile) !== element.identity
      ) {
        return [];
      }
      return this.currentFileChildren(snapshot, element.identity);
    }

    if (element instanceof NotesWorkspaceOverviewItem) {
      return this.workspaceOverviewChildren();
    }

    if (element instanceof NotesWorkspaceFolderItem) {
      return element.children;
    }

    if (element) {
      return [];
    }

    if (snapshot.loading) {
      return [new NotesStatusItem('Loading notes for the active file...', 'loading~spin')];
    }

    if (snapshot.error) {
      return [new NotesStatusItem(snapshot.error, 'error')];
    }

    if (!snapshot.sourceFile) {
      return this.workspaceOverviewRoot();
    }

    return [this.createFileHeader(snapshot.sourceFile)];
  }

  private currentFileChildren(snapshot: ReturnType<CurrentFileNotesStore['getSnapshot']>, fileIdentity: string): TreeNode[] {
    if (snapshot.notes.length === 0) {
      return [new NotesStatusItem(
        'No notes are attached to this file.',
        'note',
        COMMAND_IDS.addNote,
      )];
    }

    const groups = groupNotesByAnchor(snapshot.notes);
    const children: TreeNode[] = [];

    for (const group of groups.symbolGroups) {
      children.push(new NotesSymbolGroupItem(
        group.name,
        group.notes,
        `${fileIdentity}:symbol:${group.name}`,
      ));
    }

    if (groups.lineNotes.length > 0) {
      children.push(new NotesAnchorGroupItem('Line', groups.lineNotes, `${fileIdentity}:line`));
    }

    if (groups.unresolvedNotes.length > 0) {
      children.push(new NotesAnchorGroupItem(
        'Unresolved',
        groups.unresolvedNotes,
        `${fileIdentity}:unresolved`,
      ));
    }

    return children;
  }

  private createFileHeader(sourceFile: string): NotesFileHeaderItem {
    const identity = this.fileIdentity(sourceFile);
    return new NotesFileHeaderItem(sourceFile, identity, this.collapsedFiles[identity] ?? false);
  }

  private fileIdentity(sourceFile: string): string {
    const workspaceRoot = this.getWorkspaceRoot();
    return JSON.stringify([
      'file',
      path.resolve(workspaceRoot),
      path.resolve(getVaultRoot(workspaceRoot)),
      sourceFile,
    ]);
  }

  private workspaceOverviewRoot(): TreeNode[] {
    if (this.workspaceOverviewError) {
      return [new NotesStatusItem(this.workspaceOverviewError, 'error')];
    }

    if (!this.workspaceOverview) {
      void this.ensureWorkspaceOverviewLoaded();
      return [new NotesStatusItem('Loading workspace notes...', 'loading~spin')];
    }

    const children = this.workspaceOverviewChildrenSync();

    if (children.length === 0) {
      return [new NotesStatusItem('No notes found in this workspace yet.', 'note')];
    }

    return [new NotesWorkspaceOverviewItem(), ...children];
  }

  private workspaceOverviewChildren(): Array<NotesWorkspaceFolderItem | NotesWorkspaceFileItem> {
    void this.ensureWorkspaceOverviewLoaded();
    return this.workspaceOverviewChildrenSync();
  }

  private workspaceOverviewChildrenSync(): Array<NotesWorkspaceFolderItem | NotesWorkspaceFileItem> {
    if (!this.workspaceOverview) {
      return [];
    }

    let workspaceRoot: string;

    try {
      workspaceRoot = this.getWorkspaceRoot();
    } catch {
      return [];
    }

    return buildWorkspaceNoteTreeFromExplorer(this.workspaceOverview.root)
      .map((node) => this.toWorkspaceItem(node, workspaceRoot));
  }

  private async ensureWorkspaceOverviewLoaded(): Promise<void> {
    if (this.workspaceOverview) {
      return;
    }

    if (!this.workspaceOverviewLoad) {
      this.workspaceOverviewLoad = this.loadWorkspaceOverview()
        .then((overview) => {
          this.workspaceOverview = overview;
          this.workspaceOverviewError = undefined;
        })
        .catch((error: unknown) => {
          this.workspaceOverviewError =
            error instanceof Error
              ? error.message
              : 'Failed to load workspace note overview.';
        })
        .finally(() => {
          this.workspaceOverviewLoad = undefined;
          this.notifyTreeChanged();
        });
    }

    await this.workspaceOverviewLoad;
  }

  private notifyTreeChanged(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  private toWorkspaceItem(
    node: WorkspaceTreeNode,
    workspaceRoot: string,
  ): NotesWorkspaceFolderItem | NotesWorkspaceFileItem {
    if (node.kind === 'file') {
      return new NotesWorkspaceFileItem(workspaceRoot, node.path, node.noteCount);
    }

    return new NotesWorkspaceFolderItem(
      node.path,
      node.noteCount,
      node.children.map((child) => this.toWorkspaceItem(child, workspaceRoot)),
    );
  }
}
