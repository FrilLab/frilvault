import * as path from 'node:path';

import * as vscode from 'vscode';

import type { NoteView, TagSummary } from '../../types';
import { ContextualRefresh } from '../refresh/contextualRefresh';
import { prepareTaggedNotes, prepareTagSummaries } from './presentation';
import {
  TagExplorerNoteItem,
  TagExplorerStatusItem,
  TagExplorerTagItem,
  type TagExplorerTreeNode,
} from './view';

export interface TagExplorerContext {
  workspaceRoot: string;
  vaultRoot: string;
  filter?: string;
}

interface TagSnapshot {
  contextKey: string | undefined;
  summaries: TagSummary[];
  loaded: boolean;
  loading: boolean;
  error: string | undefined;
}

interface TagNoteSnapshot {
  context: TagExplorerContext;
  tag: string;
  values: NoteView[] | undefined;
  loaded: boolean;
  loading: boolean;
  error: string | undefined;
  refresh: ContextualRefresh<NoteView[]>;
}

const EMPTY_SNAPSHOT: TagSnapshot = {
  contextKey: undefined,
  summaries: [],
  loaded: false,
  loading: false,
  error: undefined,
};

export class FrilVaultTagExplorerProvider
implements vscode.TreeDataProvider<TagExplorerTreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter =
    new vscode.EventEmitter<TagExplorerTreeNode | undefined>();
  private readonly tagRefresh = new ContextualRefresh<TagSummary[]>();
  private readonly noteSnapshots = new Map<string, TagNoteSnapshot>();
  private snapshot: TagSnapshot = { ...EMPTY_SNAPSHOT };
  private contextError: string | undefined;
  private disposed = false;

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly loadTags: (context: TagExplorerContext) => Promise<TagSummary[]>,
    private readonly loadNotes: (tag: string, context: TagExplorerContext) => Promise<NoteView[]>,
    private readonly isEnabled: () => boolean = () => true,
    private readonly getContext: () => TagExplorerContext | undefined = () => ({
      workspaceRoot: '',
      vaultRoot: '',
    }),
  ) {}

  /** Refreshes this context; same-context invalidations share the active read. */
  public async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.isEnabled()) {
      this.clear();
      return;
    }

    const context = this.readContext();
    if (!context) {
      this.clear();
      return;
    }

    const contextKey = tagContextKey(context);
    const contextChanged = this.snapshot.contextKey !== contextKey;
    this.useContext(context, contextKey, false);
    const jobs = [this.refreshTags(context, contextKey, !contextChanged)];

    for (const [key, snapshot] of this.noteSnapshots) {
      if (key.startsWith(`${contextKey}\0`)) {
        jobs.push(this.refreshTagNotes(snapshot, contextKey, true));
      }
    }

    await Promise.all(jobs);
  }

  public clear(): void {
    if (this.disposed) {
      return;
    }

    this.tagRefresh.clear();
    for (const snapshot of this.noteSnapshots.values()) {
      snapshot.refresh.dispose();
    }
    const changed = this.snapshot.contextKey !== undefined
      || this.snapshot.loaded
      || this.snapshot.loading
      || this.snapshot.error !== undefined
      || this.snapshot.summaries.length > 0;
    this.noteSnapshots.clear();
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.contextError = undefined;
    if (changed) {
      this.notifyTreeChanged();
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.tagRefresh.dispose();
    for (const snapshot of this.noteSnapshots.values()) {
      snapshot.refresh.dispose();
    }
    this.noteSnapshots.clear();
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.contextError = undefined;
    this.onDidChangeTreeDataEmitter.dispose();
  }

  public getTreeItem(element: TagExplorerTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TagExplorerTreeNode): Promise<TagExplorerTreeNode[]> {
    if (this.disposed) {
      return [];
    }
    if (!this.isEnabled()) {
      this.clear();
      return [new TagExplorerStatusItem('Disabled for this workspace.', 'debug-pause')];
    }

    const context = this.readContext();
    if (!context) {
      const message = this.contextError ?? 'FrilVault requires an open workspace folder.';
      this.clear();
      return [new TagExplorerStatusItem(message, 'error')];
    }

    const contextKey = tagContextKey(context);
    this.useContext(context, contextKey);

    if (element instanceof TagExplorerTagItem) {
      if (element.contextKey !== undefined && element.contextKey !== contextKey) {
        return [];
      }
      if (!this.snapshot.summaries.some(
        (summary) => summary.tag.trim().toLowerCase() === element.summary.tag.trim().toLowerCase(),
      )) {
        return [];
      }
      return this.getNotes(element.summary.tag, context, contextKey);
    }
    if (element) {
      return [];
    }

    if (!this.snapshot.loaded && !this.snapshot.loading) {
      void this.refreshTags(context, contextKey, false);
    }
    if (!this.snapshot.loaded && this.snapshot.loading) {
      return [new TagExplorerStatusItem('Loading tags...', 'loading~spin')];
    }
    if (this.snapshot.error && this.snapshot.summaries.length === 0) {
      return [new TagExplorerStatusItem(this.snapshot.error, 'error')];
    }

    const rows: TagExplorerTreeNode[] = this.snapshot.summaries.length === 0
      ? [new TagExplorerStatusItem(
        'No tagged notes. Add tags when creating or editing a note.',
        'tag',
      )]
      : this.snapshot.summaries.map((summary) => new TagExplorerTagItem(summary, contextKey));
    if (this.snapshot.error) {
      rows.push(new TagExplorerStatusItem(this.snapshot.error, 'error'));
    }
    return rows;
  }

  private useContext(
    context: TagExplorerContext,
    contextKey: string,
    startLoad = true,
  ): void {
    if (this.snapshot.contextKey === contextKey) {
      return;
    }

    this.tagRefresh.clear();
    for (const snapshot of this.noteSnapshots.values()) {
      snapshot.refresh.dispose();
    }
    this.noteSnapshots.clear();
    this.snapshot = {
      contextKey,
      summaries: [],
      loaded: false,
      loading: true,
      error: undefined,
    };
    this.notifyTreeChanged();
    if (startLoad) {
      void this.refreshTags(context, contextKey, false);
    }
  }

  private async refreshTags(
    context: TagExplorerContext,
    contextKey: string,
    invalidated: boolean,
  ): Promise<void> {
    await this.tagRefresh.run(
      contextKey,
      () => this.loadTags(context),
      (summaries) => {
        if (this.snapshot.contextKey !== contextKey || this.disposed) {
          return;
        }
        const nextSummaries = prepareTagSummaries(summaries);
        this.pruneRemovedTagNotes(contextKey, nextSummaries);
        const previous = this.snapshot;
        const next: TagSnapshot = {
          contextKey,
          summaries: nextSummaries,
          loaded: true,
          loading: false,
          error: undefined,
        };
        this.snapshot = next;
        if (!tagSnapshotsEqual(previous, next)) {
          this.notifyTreeChanged();
        }
      },
      (error) => {
        if (this.snapshot.contextKey !== contextKey || this.disposed) {
          return;
        }
        const previous = this.snapshot;
        this.snapshot = {
          ...previous,
          loaded: true,
          loading: false,
          error: errorMessage(error, 'Failed to load tags.'),
        };
        if (!tagSnapshotsEqual(previous, this.snapshot)) {
          this.notifyTreeChanged();
        }
      },
      invalidated,
    );
  }

  private getNotes(
    tag: string,
    context: TagExplorerContext,
    contextKey: string,
  ): TagExplorerTreeNode[] {
    const loadKey = `${contextKey}\0${tag.trim().toLowerCase()}`;
    let snapshot = this.noteSnapshots.get(loadKey);
    if (!snapshot) {
      snapshot = {
        context,
        tag,
        values: undefined,
        loaded: false,
        loading: false,
        error: undefined,
        refresh: new ContextualRefresh<NoteView[]>(),
      };
      this.noteSnapshots.set(loadKey, snapshot);
      void this.refreshTagNotes(snapshot, contextKey, false);
    }

    if (!snapshot.loaded && snapshot.loading) {
      return [new TagExplorerStatusItem('Loading tagged notes...', 'loading~spin')];
    }
    if (snapshot.error && snapshot.values === undefined) {
      return [new TagExplorerStatusItem(snapshot.error, 'error')];
    }
    if (!snapshot.loaded) {
      return [];
    }

    const rows: TagExplorerTreeNode[] = prepareTaggedNotes(snapshot.values ?? [])
      .map((note) => new TagExplorerNoteItem(note));
    if (snapshot.error) {
      rows.push(new TagExplorerStatusItem(snapshot.error, 'error'));
    }
    return rows;
  }

  private async refreshTagNotes(
    snapshot: TagNoteSnapshot,
    contextKey: string,
    invalidated: boolean,
  ): Promise<void> {
    const loadKey = `${contextKey}\0${snapshot.tag.trim().toLowerCase()}`;
    snapshot.loading = snapshot.values === undefined;
    await snapshot.refresh.run(
      loadKey,
      () => this.loadNotes(snapshot.tag, snapshot.context),
      (notes) => {
        if (this.disposed || this.snapshot.contextKey !== contextKey
          || this.noteSnapshots.get(loadKey) !== snapshot) {
          return;
        }
        const values = prepareTaggedNotes(notes);
        const changed = !snapshot.loaded
          || snapshot.error !== undefined
          || JSON.stringify(snapshot.values) !== JSON.stringify(values);
        snapshot.values = values;
        snapshot.loaded = true;
        snapshot.loading = false;
        snapshot.error = undefined;
        if (changed) {
          this.notifyTreeChanged();
        }
      },
      (error) => {
        if (this.disposed || this.snapshot.contextKey !== contextKey
          || this.noteSnapshots.get(loadKey) !== snapshot) {
          return;
        }
        const nextError = errorMessage(error, `Failed to load notes tagged '${snapshot.tag}'.`);
        const changed = snapshot.error !== nextError || !snapshot.loaded;
        snapshot.loaded = true;
        snapshot.loading = false;
        snapshot.error = nextError;
        if (changed) {
          this.notifyTreeChanged();
        }
      },
      invalidated,
    );
  }

  private notifyTreeChanged(): void {
    if (!this.disposed) {
      this.onDidChangeTreeDataEmitter.fire(undefined);
    }
  }

  private pruneRemovedTagNotes(contextKey: string, summaries: TagSummary[]): void {
    const currentTags = new Set(summaries.map((summary) => summary.tag.trim().toLowerCase()));
    for (const [key, snapshot] of this.noteSnapshots) {
      if (key.startsWith(`${contextKey}\0`)
        && !currentTags.has(snapshot.tag.trim().toLowerCase())) {
        snapshot.refresh.dispose();
        this.noteSnapshots.delete(key);
      }
    }
  }

  private readContext(): TagExplorerContext | undefined {
    try {
      this.contextError = undefined;
      return this.getContext();
    } catch (error) {
      this.contextError = errorMessage(error, 'Failed to resolve the Tag workspace context.');
      return undefined;
    }
  }
}

function tagContextKey(context: TagExplorerContext): string {
  return JSON.stringify([
    path.resolve(context.workspaceRoot),
    path.resolve(context.vaultRoot),
    context.filter?.trim() ?? '',
  ]);
}

function tagSnapshotsEqual(left: TagSnapshot, right: TagSnapshot): boolean {
  return left.contextKey === right.contextKey
    && left.loaded === right.loaded
    && left.loading === right.loading
    && left.error === right.error
    && JSON.stringify(left.summaries) === JSON.stringify(right.summaries);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
