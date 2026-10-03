import * as assert from 'node:assert';
import * as path from 'node:path';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import type { CliClient } from '../core/cliClient';
import { registerWorkspaceWatcher, isTrackedSourcePath } from '../features/workspace/watcher';
import type { SyncResult } from '../types';

suite('Workspace watcher', () => {
  test('ignores generated and temporary source paths while retaining relevant files', () => {
    const root = '/tmp/workspace';
    const tracked = (relativePath: string) => isTrackedSourcePath(root, vscode.Uri.file(path.join(root, relativePath)));

    assert.strictEqual(tracked('src/main.rs'), true);
    assert.strictEqual(tracked('target/debug/build/generated.rs'), false);
    assert.strictEqual(tracked('dist/generated.js'), false);
    assert.strictEqual(tracked('node_modules/pkg/generated.js'), false);
    assert.strictEqual(tracked('src/main.rs.tmp'), false);
  });

  test('serializes same-context syncs and catches events received during a sync', async () => {
    const root = '/tmp/workspace';
    const firstSync = deferred<SyncResult>();
    const secondSync = deferred<SyncResult>();
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstStart = new Promise<void>((resolve) => { firstStarted = resolve; });
    const secondStart = new Promise<void>((resolve) => { secondStarted = resolve; });
    let syncCalls = 0;
    const syncOptions: Array<{ notesOnly?: boolean; sourcesOnly?: boolean }> = [];
    let activeSyncs = 0;
    let maximumConcurrentSyncs = 0;
    let noteCreate: ((uri: vscode.Uri) => void) | undefined;
    let noteChange: ((uri: vscode.Uri) => void) | undefined;
    let timerCallback: (() => void | Promise<void>) | undefined;
    let timerId = 0;
    const subscriptions: vscode.Disposable[] = [];
    const cliClient = {
      workspaceStatus: async () => ({ vault_path: '.vault', mode: 'local', git_tracking: 'excluded', note_count: 0 }),
      sync: async (_workspaceRoot: string, options: { notesOnly?: boolean; sourcesOnly?: boolean }) => {
        syncCalls += 1;
        syncOptions.push(options);
        activeSyncs += 1;
        maximumConcurrentSyncs = Math.max(maximumConcurrentSyncs, activeSyncs);
        if (syncCalls === 1) {
          firstStarted();
          const result = await firstSync.promise;
          activeSyncs -= 1;
          return result;
        }
        secondStarted();
        const result = await secondSync.promise;
        activeSyncs -= 1;
        return result;
      },
    } as unknown as CliClient;
    const createWatcher = ((pattern: vscode.RelativePattern) => {
      const isNotes = pattern.base.endsWith('.vault');
      return {
        onDidCreate: (listener: (uri: vscode.Uri) => void) => {
          if (isNotes) {
            noteCreate = listener;
          }
          return new vscode.Disposable(() => undefined);
        },
        onDidChange: (listener: (uri: vscode.Uri) => void) => {
          if (isNotes) {
            noteChange = listener;
          }
          return new vscode.Disposable(() => undefined);
        },
        onDidDelete: () => new vscode.Disposable(() => undefined),
        dispose: () => undefined,
      } as unknown as vscode.FileSystemWatcher;
    }) as typeof vscode.workspace.createFileSystemWatcher;
    const setTimer = ((callback: () => void) => {
      timerId += 1;
      timerCallback = callback;
      return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimer = (() => { timerCallback = undefined; }) as typeof clearTimeout;
    const context = { subscriptions } as unknown as vscode.ExtensionContext;
    let invalidations = 0;

    const watcherHandle = registerWorkspaceWatcher(
      context,
      cliClient,
      () => true,
      async () => { invalidations += 1; },
      {
        getWorkspaceRoot: () => root,
        createFileSystemWatcher: createWatcher,
        onDidChangeConfiguration: (() => new vscode.Disposable(() => undefined)) as
          typeof vscode.workspace.onDidChangeConfiguration,
        onDidChangeWorkspaceFolders: (() => new vscode.Disposable(() => undefined)) as
          typeof vscode.workspace.onDidChangeWorkspaceFolders,
        setTimeout: setTimer,
        clearTimeout: clearTimer,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const noteUri = vscode.Uri.file(path.join(root, '.vault/notes/src/main.rs.json'));
    noteCreate?.(noteUri);
    const timer = timerCallback;
    timerCallback = undefined;
    const firstJob = timer?.();
    await firstStart;

    noteChange?.(noteUri);
    watcherHandle.syncSourceChanges('test-rename');
    assert.strictEqual(timerCallback, undefined, 'an in-flight sync keeps one pending dirty bit instead of starting another timer');
    firstSync.resolve({ notes_synced: true, repairs_applied: 0 });
    await secondStart;
    assert.strictEqual(maximumConcurrentSyncs, 1);
    secondSync.resolve({ notes_synced: true, repairs_applied: 0 });
    await firstJob;

    assert.strictEqual(syncCalls, 2);
    assert.deepStrictEqual(syncOptions, [{ notesOnly: true }, {}]);
    assert.strictEqual(invalidations, 2);
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });

  test('uses notes-only and sources-only sync scopes and skips unchanged source results', async () => {
    const root = '/tmp/workspace';
    const calls: Array<{ notesOnly?: boolean; sourcesOnly?: boolean }> = [];
    const results: SyncResult[] = [
      { notes_synced: true, repairs_applied: 0 },
      { notes_synced: false, repairs_applied: 0 },
      { notes_synced: false, repairs_applied: 1 },
    ];
    let noteCreate: ((uri: vscode.Uri) => void) | undefined;
    let sourceCreate: ((uri: vscode.Uri) => void) | undefined;
    let timerCallback: (() => void | Promise<void>) | undefined;
    let timerId = 0;
    const cliClient = {
      workspaceStatus: async () => ({ vault_path: '.vault', mode: 'local', git_tracking: 'excluded', note_count: 0 }),
      sync: async (_workspaceRoot: string, options: { notesOnly?: boolean; sourcesOnly?: boolean }) => {
        calls.push(options);
        return results.shift() ?? { notes_synced: false, repairs_applied: 0 };
      },
    } as unknown as CliClient;
    const createWatcher = ((pattern: vscode.RelativePattern) => {
      const isNotes = pattern.base.endsWith('.vault');
      const isSource = pattern.base === root;
      return {
        onDidCreate: (listener: (uri: vscode.Uri) => void) => {
          if (isNotes) {
            noteCreate = listener;
          }
          if (isSource) {
            sourceCreate = listener;
          }
          return new vscode.Disposable(() => undefined);
        },
        onDidChange: () => new vscode.Disposable(() => undefined),
        onDidDelete: () => new vscode.Disposable(() => undefined),
        dispose: () => undefined,
      } as unknown as vscode.FileSystemWatcher;
    }) as typeof vscode.workspace.createFileSystemWatcher;
    const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
    const setTimer = ((callback: () => void) => {
      timerId += 1;
      timerCallback = callback;
      return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimer = (() => { timerCallback = undefined; }) as typeof clearTimeout;
    let invalidations = 0;

    registerWorkspaceWatcher(
      context,
      cliClient,
      () => true,
      async () => { invalidations += 1; },
      {
        getWorkspaceRoot: () => root,
        createFileSystemWatcher: createWatcher,
        onDidChangeConfiguration: (() => new vscode.Disposable(() => undefined)) as
          typeof vscode.workspace.onDidChangeConfiguration,
        onDidChangeWorkspaceFolders: (() => new vscode.Disposable(() => undefined)) as
          typeof vscode.workspace.onDidChangeWorkspaceFolders,
        setTimeout: setTimer,
        clearTimeout: clearTimer,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    noteCreate?.(vscode.Uri.file(path.join(root, '.vault/notes/src/main.json')));
    await runTimer();
    sourceCreate?.(vscode.Uri.file(path.join(root, 'src/main.rs')));
    await runTimer();
    sourceCreate?.(vscode.Uri.file(path.join(root, 'target/debug/generated.rs')));
    assert.strictEqual(timerCallback, undefined);
    sourceCreate?.(vscode.Uri.file(path.join(root, 'src/renamed.rs')));
    await runTimer();

    assert.deepStrictEqual(calls, [
      { notesOnly: true },
      { sourcesOnly: true },
      { sourcesOnly: true },
    ]);
    assert.strictEqual(invalidations, 2, 'source syncs invalidate views only when repairs were applied');
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    async function runTimer(): Promise<void> {
      const callback = timerCallback;
      timerCallback = undefined;
      await callback?.();
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
