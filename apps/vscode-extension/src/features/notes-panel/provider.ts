import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../constants/ids';
import { WorkspaceNoteCountStore } from '../explorer-badges/store';
import {
  CurrentFileNotesStore,
} from '../current-file/store';
import { buildWorkspaceNoteTree, groupNotesByAnchor, type WorkspaceTreeNode } from './presentation';
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
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  private workspaceOverviewLoad: Promise<void> | undefined;
  private workspaceOverviewError: string | undefined;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly store: CurrentFileNotesStore,
    private readonly noteCountStore: WorkspaceNoteCountStore,
    private readonly getWorkspaceRoot: () => string,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!this.isEnabled()) {
      return [new NotesStatusItem('FrilVault is disabled for this workspace.', 'debug-pause')];
    }

    const snapshot = this.store.getSnapshot();

    if (element instanceof NotesSymbolGroupItem || element instanceof NotesAnchorGroupItem) {
      return element.notes.map((note) => new NotesPanelItem(note, this.getWorkspaceRoot()));
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

    if (snapshot.notes.length === 0) {
      return [
        new NotesFileHeaderItem(snapshot.sourceFile),
        new NotesStatusItem(
          'No FrilVault notes are attached to this file.',
          'note',
          COMMAND_IDS.addNote,
        ),
      ];
    }

    const groups = groupNotesByAnchor(snapshot.notes);
    const children: TreeNode[] = [new NotesFileHeaderItem(snapshot.sourceFile)];

    for (const group of groups.symbolGroups) {
      children.push(new NotesSymbolGroupItem(group.name, group.notes));
    }

    if (groups.lineNotes.length > 0) {
      children.push(new NotesAnchorGroupItem('Line', groups.lineNotes));
    }

    if (groups.unresolvedNotes.length > 0) {
      children.push(new NotesAnchorGroupItem('Unresolved', groups.unresolvedNotes));
    }

    return children;
  }

  private workspaceOverviewRoot(): TreeNode[] {
    if (!this.noteCountStore.isLoaded()) {
      void this.ensureWorkspaceOverviewLoaded();
      return [new NotesStatusItem('Loading workspace notes...', 'loading~spin')];
    }

    if (this.workspaceOverviewError) {
      return [new NotesStatusItem(this.workspaceOverviewError, 'error')];
    }

    const children = this.workspaceOverviewChildrenSync();

    if (children.length === 0) {
      return [new NotesStatusItem('No FrilVault notes found in this workspace yet.', 'note')];
    }

    return [new NotesWorkspaceOverviewItem(), ...children];
  }

  private workspaceOverviewChildren(): Array<NotesWorkspaceFolderItem | NotesWorkspaceFileItem> {
    void this.ensureWorkspaceOverviewLoaded();
    return this.workspaceOverviewChildrenSync();
  }

  private workspaceOverviewChildrenSync(): Array<NotesWorkspaceFolderItem | NotesWorkspaceFileItem> {
    let workspaceRoot: string;

    try {
      workspaceRoot = this.getWorkspaceRoot();
    } catch {
      return [];
    }

    return buildWorkspaceNoteTree(this.noteCountStore.listIndexedFiles())
      .map((node) => this.toWorkspaceItem(node, workspaceRoot));
  }

  private async ensureWorkspaceOverviewLoaded(): Promise<void> {
    if (this.noteCountStore.isLoaded()) {
      return;
    }

    if (!this.workspaceOverviewLoad) {
      this.workspaceOverviewLoad = this.noteCountStore
        .reload()
        .then(() => {
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
          this.refresh();
        });
    }

    await this.workspaceOverviewLoad;
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
