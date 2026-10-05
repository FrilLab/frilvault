import * as path from 'node:path';

import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../constants/ids';
import type { CurrentFileNotesStore, CurrentFileNotesSnapshot } from '../current-file/store';
import type { NoteView, WorkspaceExplorer } from '../../types';
import { getVaultRoot } from '../../utils/file';
import { ContextualRefresh } from '../refresh/contextualRefresh';
import type { RefreshTraceSink } from '../refresh/diagnostics';
import { workspaceVaultContextKey } from '../refresh/contextIdentity';
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

export interface NotesWorkspaceContext {
  workspaceRoot: string;
  vaultRoot: string;
  key: string;
}

interface WorkspaceOverviewSnapshot {
  contextKey: string | undefined;
  value: WorkspaceExplorer | undefined;
  loaded: boolean;
  loading: boolean;
  error: string | undefined;
}

const EMPTY_OVERVIEW: WorkspaceOverviewSnapshot = {
  contextKey: undefined,
  value: undefined,
  loaded: false,
  loading: false,
  error: undefined,
};

export class FrilVaultNotesProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private static readonly FILE_COLLAPSE_STATE_KEY = 'frilvault.notes.collapsedFiles.v1';
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  private readonly collapsedFiles: Record<string, boolean>;
  private readonly overviewRefresh: ContextualRefresh<WorkspaceExplorer>;
  private overview: WorkspaceOverviewSnapshot = { ...EMPTY_OVERVIEW };
  private currentContext: NotesWorkspaceContext | undefined;
  private contextError: string | undefined;
  private disposed = false;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly store: CurrentFileNotesStore,
    private readonly loadWorkspaceOverview: (
      context: NotesWorkspaceContext,
    ) => Promise<WorkspaceExplorer>,
    private readonly getWorkspaceRoot: () => string,
    private readonly isEnabled: () => boolean = () => true,
    private readonly workspaceState?: vscode.Memento,
    private readonly getWorkspaceContext?: () =>
      | { workspaceRoot: string; vaultRoot: string }
      | undefined,
    trace?: RefreshTraceSink,
  ) {
    this.collapsedFiles = workspaceState?.get<Record<string, boolean>>(
      FrilVaultNotesProvider.FILE_COLLAPSE_STATE_KEY,
      {},
    ) ?? {};
    this.overviewRefresh = new ContextualRefresh('workspace-overview', trace);
  }

  /** Redraws the tree without invalidating the workspace data snapshot. */
  public refresh(): void {
    this.notifyTreeChanged();
  }

  /** Revalidates the current workspace/Vault snapshot after a real data change. */
  public invalidateWorkspaceOverview(trigger = 'workspace-change'): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!this.isEnabled()) {
      this.clear();
      return Promise.resolve();
    }

    const context = this.readContext();
    if (!context) {
      this.clear();
      this.notifyTreeChanged();
      return Promise.resolve();
    }
    this.useContext(context);
    return this.loadOverview(context, true, trigger);
  }

  public clear(): void {
    if (this.disposed) {
      return;
    }
    const changed = this.currentContext !== undefined
      || this.overview.loaded
      || this.overview.loading
      || this.overview.error !== undefined
      || this.overview.value !== undefined;
    this.overviewRefresh.clear();
    this.currentContext = undefined;
    this.overview = { ...EMPTY_OVERVIEW };
    if (changed) {
      this.notifyTreeChanged();
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.overviewRefresh.dispose();
    this.overview = { ...EMPTY_OVERVIEW };
    this.currentContext = undefined;
    this.onDidChangeTreeDataEmitter.dispose();
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
    if (this.disposed) {
      return [];
    }
    if (!this.isEnabled()) {
      this.clear();
      return [new NotesStatusItem('Disabled for this workspace.', 'debug-pause')];
    }

    const context = this.readContext();
    if (!context) {
      this.clear();
      return [new NotesStatusItem(
        this.contextError ?? 'FrilVault requires an open workspace folder.',
        'error',
      )];
    }
    this.useContext(context);

    if (element instanceof NotesWorkspaceOverviewItem) {
      if (element.contextKey !== context.key) {
        return [];
      }
      return this.workspaceOverviewChildren(context);
    }

    if (element instanceof NotesWorkspaceFolderItem) {
      return element.contextKey === context.key ? element.children : [];
    }

    if (element instanceof NotesFileHeaderItem) {
      const snapshot = this.store.getSnapshot();
      if (
        element.contextKey !== context.key ||
        snapshot.sourceFile !== element.sourceFile ||
        snapshot.loading ||
        snapshot.notes.length === 0
      ) {
        return [];
      }
      return this.currentFileChildren(snapshot, element.identity, context.key);
    }

    if (element instanceof NotesSymbolGroupItem || element instanceof NotesAnchorGroupItem) {
      if (element.contextKey !== context.key) {
        return [];
      }
      return element.notes.map((note) => new NotesPanelItem(note, context.workspaceRoot));
    }

    if (element) {
      return [];
    }

    if (!this.overview.loaded && !this.overview.loading) {
      void this.loadOverview(context, false, 'initial-view');
    }
    return this.rootChildren(context, this.store.getSnapshot());
  }

  private async loadOverview(
    context: NotesWorkspaceContext,
    invalidateIfRunning: boolean,
    trigger: string,
  ): Promise<void> {
    if (this.disposed || this.overview.contextKey !== context.key) {
      return;
    }
    if (this.overview.value === undefined && !this.overview.loading) {
      this.overview = { ...this.overview, loading: true, error: undefined };
      this.notifyTreeChanged();
    }

    await this.overviewRefresh.run(
      context.key,
      () => this.loadWorkspaceOverview(context),
      (value) => {
        if (this.disposed || this.currentContext?.key !== context.key) {
          return false;
        }
        const previousSignature = this.overview.value
          ? JSON.stringify(buildWorkspaceNoteTreeFromExplorer(this.overview.value.root))
          : undefined;
        const nextSignature = JSON.stringify(buildWorkspaceNoteTreeFromExplorer(value.root));
        const changed = !this.overview.loaded
          || previousSignature !== nextSignature
          || this.overview.error !== undefined;
        this.overview = {
          contextKey: context.key,
          value,
          loaded: true,
          loading: false,
          error: undefined,
        };
        if (changed) {
          this.notifyTreeChanged();
        }
        return changed;
      },
      (error) => {
        if (this.disposed || this.currentContext?.key !== context.key) {
          return;
        }
        const message = error instanceof Error
          ? error.message
          : 'Failed to load workspace note overview.';
        const changed = this.overview.error !== message || !this.overview.loaded;
        this.overview = {
          ...this.overview,
          loaded: true,
          loading: false,
          error: message,
        };
        if (changed) {
          this.notifyTreeChanged();
        }
      },
      invalidateIfRunning,
      trigger,
    );
  }

  private rootChildren(
    context: NotesWorkspaceContext,
    currentFile: CurrentFileNotesSnapshot,
  ): TreeNode[] {
    const rows: TreeNode[] = [];
    const overview = this.overview;

    if (overview.value === undefined) {
      if (overview.error) {
        rows.push(new NotesStatusItem(overview.error, 'error', COMMAND_IDS.refresh));
      } else if (!overview.loaded || overview.loading) {
        rows.push(new NotesStatusItem('Loading workspace notes...', 'loading~spin'));
      }
    } else if (overview.value) {
      const nodes = buildWorkspaceNoteTreeFromExplorer(overview.value.root);
      if (nodes.length > 0) {
        const noteCount = nodes.reduce((sum, node) => sum + node.noteCount, 0);
        rows.push(new NotesWorkspaceOverviewItem(context.key, noteCount));
      } else {
        rows.push(new NotesStatusItem(
          'No notes found in this workspace yet.',
          'note',
          COMMAND_IDS.addNote,
        ));
      }
    }

    if (overview.error && overview.value !== undefined) {
      rows.push(new NotesStatusItem(
        'Workspace notes could not be refreshed. Select to retry.',
        'warning',
        COMMAND_IDS.refresh,
      ));
    }

    if (
      currentFile.workspaceRoot &&
      path.resolve(currentFile.workspaceRoot) === path.resolve(context.workspaceRoot) &&
      currentFile.sourceFile &&
      !currentFile.loading &&
      currentFile.notes.length > 0
    ) {
      const identity = this.fileIdentity(currentFile.sourceFile, context.key);
      rows.push(new NotesFileHeaderItem(
        currentFile.sourceFile,
        identity,
        context.key,
        this.collapsedFiles[identity] ?? false,
      ));
    }

    return rows;
  }

  private workspaceOverviewChildren(context: NotesWorkspaceContext): TreeNode[] {
    if (this.overview.contextKey !== context.key || !this.overview.value) {
      return [];
    }
    return buildWorkspaceNoteTreeFromExplorer(this.overview.value.root)
      .map((node) => this.toWorkspaceItem(node, context));
  }

  private currentFileChildren(
    snapshot: CurrentFileNotesSnapshot,
    fileIdentity: string,
    contextKey: string,
  ): TreeNode[] {
    const groups = groupNotesByAnchor(snapshot.notes);
    const children: TreeNode[] = [];

    for (const group of groups.symbolGroups) {
      children.push(new NotesSymbolGroupItem(
        group.name,
        group.notes,
        `${fileIdentity}:symbol:${group.name}`,
        contextKey,
      ));
    }

    if (groups.lineNotes.length > 0) {
      children.push(new NotesAnchorGroupItem(
        'Line',
        groups.lineNotes,
        `${fileIdentity}:line`,
        contextKey,
      ));
    }

    if (groups.unresolvedNotes.length > 0) {
      children.push(new NotesAnchorGroupItem(
        'Unresolved',
        groups.unresolvedNotes,
        `${fileIdentity}:unresolved`,
        contextKey,
      ));
    }

    return children;
  }

  private toWorkspaceItem(
    node: WorkspaceTreeNode,
    context: NotesWorkspaceContext,
  ): NotesWorkspaceFolderItem | NotesWorkspaceFileItem {
    const identity = JSON.stringify(['workspace', context.key, node.kind, node.path]);
    if (node.kind === 'file') {
      return new NotesWorkspaceFileItem(
        context.workspaceRoot,
        node.path,
        node.noteCount,
        identity,
        context.key,
      );
    }

    return new NotesWorkspaceFolderItem(
      node.path,
      node.noteCount,
      node.children.map((child) => this.toWorkspaceItem(child, context)),
      identity,
      context.key,
    );
  }

  private fileIdentity(sourceFile: string, contextKey: string): string {
    return JSON.stringify(['active-file', contextKey, sourceFile]);
  }

  private useContext(context: NotesWorkspaceContext): void {
    if (this.currentContext?.key === context.key) {
      this.currentContext = context;
      return;
    }

    this.overviewRefresh.clear();
    this.currentContext = context;
    this.overview = {
      contextKey: context.key,
      value: undefined,
      loaded: false,
      loading: false,
      error: undefined,
    };
    this.notifyTreeChanged();
  }

  private readContext(): NotesWorkspaceContext | undefined {
    try {
      this.contextError = undefined;
      const context = this.getWorkspaceContext?.() ?? (() => {
        const workspaceRoot = this.getWorkspaceRoot();
        return { workspaceRoot, vaultRoot: getVaultRoot(workspaceRoot) };
      })();
      return {
        ...context,
        key: workspaceVaultContextKey(context.workspaceRoot, context.vaultRoot),
      };
    } catch (error) {
      this.contextError = error instanceof Error
        ? error.message
        : 'Failed to resolve the workspace note context.';
      return undefined;
    }
  }

  private notifyTreeChanged(): void {
    if (!this.disposed) {
      this.onDidChangeTreeDataEmitter.fire();
    }
  }
}
