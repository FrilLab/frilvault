import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CliClient, SyncOptions } from '../../core/cliClient';
import { getVaultRoot, tryGetWorkspaceRoot } from '../../utils/file';
import type { SyncResult } from '../../types';
import type { RefreshTraceSink } from '../refresh/diagnostics';
import { refreshContextId } from '../refresh/diagnostics';
import { workspaceVaultContextKey } from '../refresh/contextIdentity';

const SYNC_DEBOUNCE_MS = 300;
const IGNORED_SOURCE_DIRECTORIES = new Set([
  '.git',
  '.vault',
  '.vscode-test',
  '.next',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  'tmp',
  'temp',
]);
const TEMPORARY_SOURCE_FILE = /(?:~|\.(?:tmp|temp|swp|swo|bak|orig|rej|lock))$/i;

type SyncScope = 'notes' | 'sources' | 'all';

interface WatchContext {
  workspaceRoot: string;
  vaultRoot: string;
  key: string;
  generation: number;
}

interface QueuedSync {
  context: WatchContext;
  scope: SyncScope;
  trigger: string;
  invalidationGeneration: number;
}

interface ActiveSync extends QueuedSync {
  pending: QueuedSync | undefined;
  running: boolean;
  failed: boolean;
  requestId: number;
  promise: Promise<void>;
}

export interface WorkspaceWatcherHandle {
  (): Promise<void>;
  /** Queues a source sync through the same serializer used by workspace events. */
  syncSourceChanges(trigger?: string): void;
}

export interface WorkspaceWatcherDependencies {
  createFileSystemWatcher?: typeof vscode.workspace.createFileSystemWatcher;
  onDidChangeConfiguration?: typeof vscode.workspace.onDidChangeConfiguration;
  onDidChangeWorkspaceFolders?: typeof vscode.workspace.onDidChangeWorkspaceFolders;
  getWorkspaceRoot?: () => string | undefined;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  trace?: RefreshTraceSink;
}

export function isTrackedVaultPath(workspaceRoot: string, uri: vscode.Uri): boolean {
  const relative = path.relative(getVaultRoot(workspaceRoot), uri.fsPath);

  if (isOutsidePath(relative)) {
    return false;
  }

  return (
    relative === `notes` ||
    relative.startsWith(`notes${path.sep}`) ||
    relative === `images` ||
    relative.startsWith(`images${path.sep}`)
  );
}

export function isTrackedSourcePath(workspaceRoot: string, uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }

  const relative = path.relative(workspaceRoot, uri.fsPath);
  if (relative === '' || isOutsidePath(relative)) {
    return false;
  }

  const segments = relative.split(path.sep);
  if (segments.some((segment) => IGNORED_SOURCE_DIRECTORIES.has(segment.toLowerCase()))) {
    return false;
  }

  if (TEMPORARY_SOURCE_FILE.test(segments[segments.length - 1] ?? '')) {
    return false;
  }

  const relativeVaultPath = path.relative(getVaultRoot(workspaceRoot), uri.fsPath);
  if (!isOutsidePath(relativeVaultPath)) {
    return false;
  }

  return true;
}

export function registerWorkspaceWatcher(
  context: vscode.ExtensionContext,
  cliClient: CliClient,
  isEnabled: () => boolean,
  invalidateViews: () => Promise<void>,
  dependencies: WorkspaceWatcherDependencies = {},
): WorkspaceWatcherHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let watchers: vscode.FileSystemWatcher[] = [];
  let bindGeneration = 0;
  let requestGeneration = 0;
  let invalidationGeneration = 0;
  let activeSync: ActiveSync | undefined;
  let queuedSync: QueuedSync | undefined;
  let disposed = false;
  const createFileSystemWatcher =
    dependencies.createFileSystemWatcher ??
    vscode.workspace.createFileSystemWatcher.bind(vscode.workspace);
  const onDidChangeConfiguration =
    dependencies.onDidChangeConfiguration ??
    vscode.workspace.onDidChangeConfiguration.bind(vscode.workspace);
  const onDidChangeWorkspaceFolders = dependencies.onDidChangeWorkspaceFolders ??
    vscode.workspace.onDidChangeWorkspaceFolders.bind(vscode.workspace);
  const getWorkspaceRoot = dependencies.getWorkspaceRoot ?? tryGetWorkspaceRoot;
  const scheduleTimeout = dependencies.setTimeout ?? setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
  const trace = dependencies.trace;

  const readContext = (): WatchContext | undefined => {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        return undefined;
      }
      const vaultRoot = getVaultRoot(workspaceRoot);
      return {
        workspaceRoot,
        vaultRoot,
        key: workspaceVaultContextKey(workspaceRoot, vaultRoot),
        generation: bindGeneration,
      };
    } catch {
      return undefined;
    }
  };

  const isCurrentContext = (expected: WatchContext): boolean => {
    const current = readContext();
    return current?.key === expected.key;
  };

  const clearDebounce = () => {
    if (debounceTimer) {
      cancelTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  };

  const queueSync = (entry: QueuedSync) => {
    if (activeSync) {
      if (activeSync.context.key === entry.context.key && activeSync.running) {
        activeSync.pending = mergeQueuedSync(activeSync.pending, entry);
        trace?.({
          component: 'workspace-watcher',
          event: 'sync-queued',
          requestId: activeSync.requestId,
          contextId: refreshContextId(entry.context.key),
          contextGeneration: entry.context.generation,
          invalidationGeneration: entry.invalidationGeneration,
          trigger: entry.trigger,
          outcome: 'during-sync',
        });
        return;
      }
      queuedSync = mergeQueuedSync(queuedSync, entry);
      trace?.({
        component: 'workspace-watcher',
        event: 'sync-queued',
        contextId: refreshContextId(entry.context.key),
        contextGeneration: entry.context.generation,
        invalidationGeneration: entry.invalidationGeneration,
        trigger: entry.trigger,
        outcome: 'after-current-context',
      });
      return;
    }

    queuedSync = mergeQueuedSync(queuedSync, entry);
    clearDebounce();
    debounceTimer = scheduleTimeout(async () => {
      debounceTimer = undefined;
      await runQueuedSync();
    }, SYNC_DEBOUNCE_MS);
  };

  const runQueuedSync = async (): Promise<void> => {
    if (disposed || activeSync || !queuedSync) {
      return;
    }
    const queued = queuedSync;
    queuedSync = undefined;
    if (!isEnabled() || !isCurrentContext(queued.context)) {
      trace?.({
        component: 'workspace-watcher',
        event: 'sync-discarded',
        contextId: refreshContextId(queued.context.key),
        contextGeneration: queued.context.generation,
        invalidationGeneration: queued.invalidationGeneration,
        trigger: queued.trigger,
        outcome: 'stale-context-or-disabled',
      });
      return;
    }

    const job: ActiveSync = {
      ...queued,
      pending: undefined,
      running: true,
      failed: false,
      requestId: ++requestGeneration,
      promise: Promise.resolve(),
    };
    activeSync = job;
    job.promise = runSyncLoop(job);
    try {
      await job.promise;
    } finally {
      job.running = false;
      if (activeSync === job) {
        activeSync = undefined;
      }
      if (job.failed) {
        queuedSync = mergeQueuedSync(queuedSync, job.pending);
      } else if (job.pending) {
        queuedSync = mergeQueuedSync(queuedSync, job.pending);
      }
      if (queuedSync && !job.failed && !disposed) {
        void runQueuedSync();
      }
    }
  };

  const runSyncLoop = async (job: ActiveSync): Promise<void> => {
    let current: QueuedSync = job;
    while (!disposed && isEnabled()) {
      if (!isCurrentContext(current.context)) {
        trace?.({
          component: 'workspace-watcher',
          event: 'sync-cancelled',
          requestId: job.requestId,
          contextId: refreshContextId(current.context.key),
          contextGeneration: current.context.generation,
          invalidationGeneration: current.invalidationGeneration,
          trigger: current.trigger,
          outcome: 'stale-context',
        });
        break;
      }

      job.pending = undefined;
      const startedAt = Date.now();
      trace?.({
        component: 'workspace-watcher',
        event: 'sync-start',
        requestId: job.requestId,
        contextId: refreshContextId(current.context.key),
        contextGeneration: current.context.generation,
        invalidationGeneration: current.invalidationGeneration,
        trigger: current.trigger,
      });

      let result: SyncResult;
      try {
        result = await cliClient.sync(
          current.context.workspaceRoot,
          syncOptions(current.scope),
        );
      } catch (error) {
        job.failed = true;
        trace?.({
          component: 'workspace-watcher',
          event: 'sync-complete',
          requestId: job.requestId,
          contextId: refreshContextId(current.context.key),
          contextGeneration: current.context.generation,
          invalidationGeneration: current.invalidationGeneration,
          trigger: current.trigger,
          outcome: 'error',
          durationMs: Date.now() - startedAt,
        });
        const message = error instanceof Error ? error.message : 'Failed to sync workspace changes.';
        void vscode.window.showWarningMessage(message);
        break;
      }

      const shouldRefresh = result.notes_synced || result.repairs_applied > 0;
      trace?.({
        component: 'workspace-watcher',
        event: 'sync-complete',
        requestId: job.requestId,
        contextId: refreshContextId(current.context.key),
        contextGeneration: current.context.generation,
        invalidationGeneration: current.invalidationGeneration,
        trigger: current.trigger,
        outcome: shouldRefresh ? 'synced' : 'unchanged',
        durationMs: Date.now() - startedAt,
      });

      if (shouldRefresh && !disposed && isCurrentContext(current.context)) {
        try {
          await invalidateViews();
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : 'Failed to refresh workspace views after sync.';
          void vscode.window.showWarningMessage(message);
        }
      }

      if (!job.pending) {
        break;
      }
      current = job.pending;
    }
  };

  const scheduleSync = (watchContext: WatchContext, scope: SyncScope, trigger: string) => {
    if (disposed || !isEnabled()) {
      return;
    }
    if (!isCurrentContext(watchContext)) {
      trace?.({
        component: 'workspace-watcher',
        event: 'watcher-event',
        contextId: refreshContextId(watchContext.key),
        contextGeneration: watchContext.generation,
        trigger,
        outcome: 'ignored-stale-context',
      });
      return;
    }
    invalidationGeneration += 1;
    trace?.({
      component: 'workspace-watcher',
      event: 'watcher-event',
      contextId: refreshContextId(watchContext.key),
      contextGeneration: watchContext.generation,
      invalidationGeneration,
      trigger,
      outcome: 'accepted',
    });
    queueSync({
      context: watchContext,
      scope,
      trigger,
      invalidationGeneration,
    });
  };

  const disposeWatchers = () => {
    for (const watcher of watchers) {
      watcher.dispose();
    }
    watchers = [];
  };

  const rebindWatchers = async () => {
    const generation = ++bindGeneration;
    clearDebounce();
    queuedSync = undefined;
    disposeWatchers();

    const watchContext = readContext();
    if (!watchContext) {
      return;
    }

    try {
      await cliClient.workspaceStatus(watchContext.workspaceRoot);
    } catch {
      return;
    }

    if (disposed || generation !== bindGeneration || !isCurrentContext(watchContext)) {
      return;
    }

    const notesWatcher = createFileSystemWatcher(
      new vscode.RelativePattern(watchContext.vaultRoot, 'notes/**'),
    );
    notesWatcher.onDidCreate(() => scheduleSync(watchContext, 'notes', 'vault-note-create'));
    notesWatcher.onDidChange(() => scheduleSync(watchContext, 'notes', 'vault-note-change'));
    notesWatcher.onDidDelete(() => scheduleSync(watchContext, 'notes', 'vault-note-delete'));

    const imagesWatcher = createFileSystemWatcher(
      new vscode.RelativePattern(watchContext.vaultRoot, 'images/**'),
    );
    imagesWatcher.onDidCreate(() => scheduleSync(watchContext, 'notes', 'vault-image-create'));
    imagesWatcher.onDidChange(() => scheduleSync(watchContext, 'notes', 'vault-image-change'));
    imagesWatcher.onDidDelete(() => scheduleSync(watchContext, 'notes', 'vault-image-delete'));

    const sourceWatcher = createFileSystemWatcher(
      new vscode.RelativePattern(watchContext.workspaceRoot, '**/*'),
      false,
      true,
      false,
    );
    sourceWatcher.onDidCreate((uri) => {
      if (isTrackedSourcePath(watchContext.workspaceRoot, uri)) {
        scheduleSync(watchContext, 'sources', 'source-create');
      }
    });
    sourceWatcher.onDidDelete((uri) => {
      if (isTrackedSourcePath(watchContext.workspaceRoot, uri)) {
        scheduleSync(watchContext, 'sources', 'source-delete');
      }
    });

    watchers = [notesWatcher, imagesWatcher, sourceWatcher];
  };

  const rebindAndRefresh = async () => {
    await rebindWatchers();
    if (!disposed && isEnabled()) {
      await invalidateViews();
    }
  };

  void rebindWatchers();

  const configurationListener = onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('frilvault.vaultPath') ||
      event.affectsConfiguration('frilvault.workspaceRoot')
    ) {
      void rebindAndRefresh().catch((error: unknown) => {
        const message = error instanceof Error
          ? error.message
          : 'Failed to refresh after Vault configuration changed.';
        void vscode.window.showWarningMessage(message);
      });
    }
  });

  const workspaceFoldersListener = onDidChangeWorkspaceFolders(() => {
    void rebindAndRefresh().catch((error: unknown) => {
      const message = error instanceof Error
        ? error.message
        : 'Failed to refresh after workspace folders changed.';
      void vscode.window.showWarningMessage(message);
    });
  });

  context.subscriptions.push(
    configurationListener,
    workspaceFoldersListener,
    new vscode.Disposable(() => {
      disposed = true;
      bindGeneration += 1;
      clearDebounce();
      queuedSync = undefined;
      if (activeSync) {
        activeSync.pending = undefined;
      }
      disposeWatchers();
    }),
  );

  const handle = rebindWatchers as WorkspaceWatcherHandle;
  handle.syncSourceChanges = (trigger = 'source-rename') => {
    const watchContext = readContext();
    if (watchContext) {
      scheduleSync(watchContext, 'sources', trigger);
    }
  };
  return handle;
}

function syncOptions(scope: SyncScope): SyncOptions {
  if (scope === 'notes') {
    return { notesOnly: true };
  }
  if (scope === 'sources') {
    return { sourcesOnly: true };
  }
  return {};
}

function mergeQueuedSync(
  current: QueuedSync | undefined,
  next: QueuedSync | undefined,
): QueuedSync | undefined {
  if (!next) {
    return current;
  }
  if (!current || current.context.key !== next.context.key) {
    return next;
  }
  return {
    context: current.context,
    scope: mergeScope(current.scope, next.scope),
    trigger: current.trigger === next.trigger ? current.trigger : 'coalesced-events',
    invalidationGeneration: Math.max(current.invalidationGeneration, next.invalidationGeneration),
  };
}

function mergeScope(left: SyncScope, right: SyncScope): SyncScope {
  return left === right ? left : 'all';
}

function isOutsidePath(relative: string): boolean {
  return relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}
