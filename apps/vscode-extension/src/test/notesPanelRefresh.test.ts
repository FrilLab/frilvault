import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { COMMAND_IDS } from '../constants/ids';
import type { CurrentFileNotesSnapshot } from '../features/current-file/store';
import { FrilVaultNotesProvider } from '../features/notes-panel/provider';
import {
  NotesFileHeaderItem,
  NotesPanelItem,
  NotesStatusItem,
  NotesWorkspaceOverviewItem,
} from '../features/notes-panel/view';
import type { NoteView, WorkspaceExplorer } from '../types';

suite('Notes panel refresh', () => {
  test('presentation refresh and an empty active file retain the workspace list', async () => {
    let workspaceReads = 0;
    let snapshot = currentSnapshot({
      sourceFile: 'src/main.rs',
      notes: [],
      documentUri: 'file:///tmp/workspace/src/main.rs',
    });
    const provider = createProvider(
      () => snapshot,
      async () => {
        workspaceReads += 1;
        return workspaceOverview('src/lib.rs');
      },
    );
    await provider.invalidateWorkspaceOverview('test-initial');

    const firstRoot = await provider.getChildren();
    const overview = firstRoot.find(
      (item): item is NotesWorkspaceOverviewItem => item instanceof NotesWorkspaceOverviewItem,
    );
    assert.ok(overview);
    assert.ok(!firstRoot.some((item) => item instanceof NotesFileHeaderItem));
    const firstWorkspaceItems = await provider.getChildren(overview);
    assert.strictEqual(firstWorkspaceItems[0]?.label, 'src');
    const firstWorkspaceIds = firstWorkspaceItems.map((item) => item.id);

    snapshot = currentSnapshot({
      sourceFile: 'src/other.rs',
      notes: [],
      documentUri: 'file:///tmp/workspace/src/other.rs',
    });
    provider.refresh();
    const secondRoot = await provider.getChildren();
    const secondOverview = secondRoot.find(
      (item): item is NotesWorkspaceOverviewItem => item instanceof NotesWorkspaceOverviewItem,
    );
    assert.ok(secondOverview);
    assert.ok(!secondRoot.some((item) => item instanceof NotesFileHeaderItem));
    assert.deepStrictEqual(
      (await provider.getChildren(secondOverview)).map((item) => item.id),
      firstWorkspaceIds,
    );
    assert.strictEqual(workspaceReads, 1, 'presentation changes must not invalidate the overview');
    provider.dispose();
  });

  test('an active file section appears only when it has notes and leads with location', async () => {
    const note = lineNote('active-note', 'src/main.rs', 42, 'a long body '.repeat(10));
    let snapshot = currentSnapshot({
      sourceFile: 'src/main.rs',
      notes: [],
      documentUri: 'file:///tmp/workspace/src/main.rs',
    });
    const provider = createProvider(
      () => snapshot,
      async () => workspaceOverview('src/lib.rs'),
    );
    await provider.invalidateWorkspaceOverview('test-initial');

    assert.ok(!(await provider.getChildren()).some((item) => item instanceof NotesFileHeaderItem));

    snapshot = currentSnapshot({
      sourceFile: 'src/main.rs',
      notes: [note],
      documentUri: 'file:///tmp/workspace/src/main.rs',
    });
    provider.refresh();
    const root = await provider.getChildren();
    const activeFile = root.find(
      (item): item is NotesFileHeaderItem => item instanceof NotesFileHeaderItem,
    );
    assert.ok(activeFile);
    const groups = await provider.getChildren(activeFile);
    const noteItems = await provider.getChildren(groups[0]);
    const noteItem = noteItems[0] as NotesPanelItem;
    assert.match(String(noteItem.label), /^L42 — /);
    assert.ok(String(noteItem.label).indexOf('L42') < String(noteItem.label).indexOf('a long body'));
    provider.dispose();
  });

  test('a valid empty overview remains loaded and offers Add Note', async () => {
    let workspaceReads = 0;
    const provider = createProvider(
      () => currentSnapshot({ sourceFile: undefined, notes: [], documentUri: undefined }),
      async () => {
        workspaceReads += 1;
        return { root: { type: 'Directory', name: '', path: '', children: [] } };
      },
    );
    await provider.invalidateWorkspaceOverview('test-initial');

    const first = await provider.getChildren();
    assert.strictEqual(first.length, 1);
    assert.ok(first[0] instanceof NotesStatusItem);
    assert.strictEqual(first[0]?.command?.command, COMMAND_IDS.addNote);
    provider.refresh();
    await provider.getChildren();
    assert.strictEqual(workspaceReads, 1);
    provider.dispose();
  });

  test('an invalidation during the overview read eventually publishes the latest result', async () => {
    let workspaceReads = 0;
    const firstRead = deferred<WorkspaceExplorer>();
    let snapshot = currentSnapshot({ sourceFile: undefined, notes: [], documentUri: undefined });
    const provider = createProvider(
      () => snapshot,
      async () => {
        workspaceReads += 1;
        return workspaceReads === 1 ? firstRead.promise : workspaceOverview('src/latest.rs');
      },
    );
    const initial = provider.invalidateWorkspaceOverview('test-initial');
    await waitFor(() => workspaceReads === 1);
    const changed = provider.invalidateWorkspaceOverview('test-mutation');
    firstRead.resolve(workspaceOverview('src/stale.rs'));
    await Promise.all([initial, changed]);

    const root = await provider.getChildren();
    const overview = root.find(
      (item): item is NotesWorkspaceOverviewItem => item instanceof NotesWorkspaceOverviewItem,
    );
    assert.ok(overview);
    const files = await provider.getChildren(overview);
    assert.strictEqual(files[0]?.label, 'src');
    const folderChildren = await provider.getChildren(files[0]);
    assert.strictEqual(folderChildren[0]?.label, 'latest.rs');
    assert.strictEqual(workspaceReads, 2);
    provider.dispose();
  });

  test('a response from the previous workspace and Vault cannot replace the current overview', async () => {
    let workspaceRoot = '/tmp/workspace-a';
    let vaultRoot = '/tmp/workspace-a/.vault';
    const pending = new Map<string, ReturnType<typeof deferred<WorkspaceExplorer>>>();
    const provider = createProvider(
      () => currentSnapshot({ sourceFile: undefined, notes: [], documentUri: undefined }),
      async ({ workspaceRoot: root }) => {
        const request = deferred<WorkspaceExplorer>();
        pending.set(root, request);
        return request.promise;
      },
      () => ({ workspaceRoot, vaultRoot }),
    );

    const oldRequest = provider.invalidateWorkspaceOverview('test-initial');
    await waitFor(() => pending.has('/tmp/workspace-a'));
    workspaceRoot = '/tmp/workspace-b';
    vaultRoot = '/tmp/vault-b';
    const currentRoot = await provider.getChildren();
    assert.ok(currentRoot.some((item) => String(item.label).includes('Loading')));
    await waitFor(() => pending.has('/tmp/workspace-b'));

    pending.get('/tmp/workspace-a')?.resolve(workspaceOverview('src/old.rs'));
    await oldRequest;
    const whileLoading = await provider.getChildren();
    assert.ok(!whileLoading.some((item) => String(item.label).includes('old.rs')));

    const newReadFinished = waitForTreeChange(provider);
    pending.get('/tmp/workspace-b')?.resolve(workspaceOverview('src/current.rs'));
    await newReadFinished;
    const finalRoot = await provider.getChildren();
    const overview = finalRoot.find(
      (item): item is NotesWorkspaceOverviewItem => item instanceof NotesWorkspaceOverviewItem,
    );
    assert.ok(overview);
    assert.strictEqual((await provider.getChildren(overview))[0]?.label, 'src');
    provider.dispose();
  });

  test('disable and disposal reject pending overview responses', async () => {
    const disabledRead = deferred<WorkspaceExplorer>();
    let disabledLoadStarted = 0;
    let enabled = true;
    const disabledProvider = createProvider(
      () => currentSnapshot({ sourceFile: undefined, notes: [], documentUri: undefined }),
      async () => {
        disabledLoadStarted += 1;
        return disabledRead.promise;
      },
      undefined,
      () => enabled,
    );
    const disabledRequest = disabledProvider.invalidateWorkspaceOverview('test-pending');
    await waitFor(() => disabledLoadStarted === 1);
    enabled = false;
    const disabledRows = await disabledProvider.getChildren();
    disabledRead.resolve(workspaceOverview('src/stale.rs'));
    await disabledRequest;
    assert.match(String(disabledRows[0]?.label), /disabled/i);
    assert.deepStrictEqual(await disabledProvider.getChildren(), disabledRows);
    disabledProvider.dispose();

    const disposedRead = deferred<WorkspaceExplorer>();
    let disposedLoadStarted = 0;
    const disposedProvider = createProvider(
      () => currentSnapshot({ sourceFile: undefined, notes: [], documentUri: undefined }),
      async () => {
        disposedLoadStarted += 1;
        return disposedRead.promise;
      },
    );
    const disposedRequest = disposedProvider.invalidateWorkspaceOverview('test-dispose');
    await waitFor(() => disposedLoadStarted === 1);
    disposedProvider.dispose();
    disposedRead.resolve(workspaceOverview('src/late.rs'));
    await disposedRequest;
    assert.deepStrictEqual(await disposedProvider.getChildren(), []);
  });
});

function createProvider(
  getSnapshot: () => CurrentFileNotesSnapshot,
  loadWorkspaceOverview: (context: { workspaceRoot: string; vaultRoot: string }) => Promise<WorkspaceExplorer>,
  getContext?: () => { workspaceRoot: string; vaultRoot: string },
  isEnabled: () => boolean = () => true,
): FrilVaultNotesProvider {
  const store = { getSnapshot } as unknown as import('../features/current-file/store').CurrentFileNotesStore;
  return new FrilVaultNotesProvider(
    store,
    loadWorkspaceOverview,
    () => getContext?.().workspaceRoot ?? '/tmp/workspace',
    isEnabled,
    undefined,
    getContext ?? (() => ({ workspaceRoot: '/tmp/workspace', vaultRoot: '/tmp/workspace/.vault' })),
  );
}

function currentSnapshot(input: {
  sourceFile: string | undefined;
  notes: NoteView[];
  documentUri: string | undefined;
}): CurrentFileNotesSnapshot {
  return {
    workspaceRoot: input.sourceFile ? '/tmp/workspace' : undefined,
    sourceFile: input.sourceFile,
    editorDocumentUri: input.documentUri,
    notes: input.notes,
    error: undefined,
    loading: false,
  };
}

function lineNote(id: string, sourceFile: string, line: number, content: string): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id,
      content,
      anchor: { type: 'Line', line, column: 1 },
    },
  };
}

function workspaceOverview(sourceFile: string): WorkspaceExplorer {
  const fileName = sourceFile.split('/').pop() ?? sourceFile;
  return {
    root: {
      type: 'Directory',
      name: '',
      path: '',
      children: [{
        type: 'Directory',
        name: 'src',
        path: 'src',
        children: [{
          type: 'File',
          source_file: `src/${fileName}`,
          exists: true,
          groups: [{ type: 'LineNotes', notes: [{ id: 'workspace-note' }] }],
        }],
      }],
    },
  };
}

async function waitForTreeChange(provider: FrilVaultNotesProvider): Promise<void> {
  await new Promise<void>((resolve) => {
    let subscription: vscode.Disposable;
    subscription = provider.onDidChangeTreeData(() => {
      subscription.dispose();
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Condition was not met before the deterministic wait ended.');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
