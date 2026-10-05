import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test, teardown } from 'mocha';
import * as vscode from 'vscode';

import {
  COMMAND_IDS,
  VIEW_IDS,
  notesViewActivationEvent,
  notesViewFocusCommand,
} from '../constants/ids';
import { CurrentFileNotesStore } from '../features/current-file/store';
import { FrilVaultNotesProvider } from '../features/notes-panel/provider';
import { NotesFileHeaderItem } from '../features/notes-panel/view';
import type { NoteView } from '../types';
import {
  disposeNotesTreeDataProvider,
  isNotesTreeDataProviderRegistered,
  registerNotesTreeDataProvider,
  resetNotesTreeRegistrationForTests,
} from '../features/notes-panel/register';

suite('Notes view registration', () => {
  teardown(() => {
    resetNotesTreeRegistrationForTests();
  });

  test('registers the notes tree provider only once', () => {
    let registerCalls = 0;
    const original = vscode.window.createTreeView;

    vscode.window.createTreeView = ((viewId: string) => {
      registerCalls += 1;
      assert.strictEqual(viewId, VIEW_IDS.notes);
      return createFakeTreeView();
    }) as typeof vscode.window.createTreeView;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      const provider = createProvider();

      registerNotesTreeDataProvider(context as vscode.ExtensionContext, provider);
      registerNotesTreeDataProvider(context as vscode.ExtensionContext, provider);

      assert.strictEqual(registerCalls, 1);
      assert.strictEqual(isNotesTreeDataProviderRegistered(), true);
    } finally {
      vscode.window.createTreeView = original;
    }
  });

  test('disposes registration and allows a fresh register afterward', () => {
    let registerCalls = 0;
    const original = vscode.window.createTreeView;

    vscode.window.createTreeView = (() => {
      registerCalls += 1;
      return createFakeTreeView();
    }) as typeof vscode.window.createTreeView;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      const provider = createProvider();

      registerNotesTreeDataProvider(context as vscode.ExtensionContext, provider);
      disposeNotesTreeDataProvider();

      assert.strictEqual(isNotesTreeDataProviderRegistered(), false);

      registerNotesTreeDataProvider(context as vscode.ExtensionContext, provider);

      assert.strictEqual(registerCalls, 2);
      assert.strictEqual(isNotesTreeDataProviderRegistered(), true);
    } finally {
      vscode.window.createTreeView = original;
    }
  });

  test('subscription dispose clears registration state', () => {
    const original = vscode.window.createTreeView;
    vscode.window.createTreeView = (() => createFakeTreeView()) as typeof vscode.window.createTreeView;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      registerNotesTreeDataProvider(context as vscode.ExtensionContext, createProvider());

      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }

      assert.strictEqual(isNotesTreeDataProviderRegistered(), false);
    } finally {
      vscode.window.createTreeView = original;
    }
  });

  test('package.json uses the shared notes view and activation identifiers', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      activationEvents?: string[];
      contributes?: {
        views?: {
          explorer?: Array<{ id: string }>;
        };
        commands?: Array<{ command: string; icon?: string }>;
        menus?: {
          'view/item/context'?: Array<{ command: string; when?: string }>;
        };
      };
    };

    const explorerViews = packageJson.contributes?.views?.explorer ?? [];
    assert.ok(explorerViews.some((view) => view.id === VIEW_IDS.notes));
    assert.ok(packageJson.activationEvents?.includes(notesViewActivationEvent()));
    assert.ok(
      packageJson.contributes?.commands?.some(
        (entry) => entry.command === COMMAND_IDS.notesPanelEditNote,
      ),
    );
    const contributedCommands = new Set(
      packageJson.contributes?.commands?.map((entry) => entry.command) ?? [],
    );
    const itemContextCommands =
      packageJson.contributes?.menus?.['view/item/context']?.map((entry) => entry.command) ?? [];

    assert.ok(
      itemContextCommands.every((command) => contributedCommands.has(command)),
      'every notes view menu command must be declared in contributes.commands',
    );
    assert.ok(
      packageJson.contributes?.menus?.['view/item/context']?.some(
        (entry) => entry.command === COMMAND_IDS.notesPanelOpenNote,
      ),
    );
    assert.ok(packageJson.contributes?.menus?.['view/item/context']?.some(
      (entry) => entry.command === COMMAND_IDS.notesPanelEditNote
        && entry.when?.includes('view == frilvault.tags')
        && entry.when.includes('viewItem == frilvault.tagNote'),
    ));
    assert.strictEqual(
      packageJson.contributes?.commands?.find((entry) => entry.command === COMMAND_IDS.addNote)?.icon,
      '$(add)',
    );
    assert.strictEqual(
      packageJson.contributes?.commands?.find((entry) => entry.command === COMMAND_IDS.refresh)?.icon,
      '$(refresh)',
    );
    assert.strictEqual(notesViewFocusCommand(), `${VIEW_IDS.notes}.focus`);
  });

  test('file parent keeps a stable identity and remembers its collapse state', async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: <T>(key: string, defaultValue: T): T => (values.get(key) as T | undefined) ?? defaultValue,
      update: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    } as unknown as vscode.Memento;
    const snapshot = {
      workspaceRoot: '/tmp/workspace',
      sourceFile: 'src/main.rs',
      editorDocumentUri: 'file:///tmp/workspace/src/main.rs',
      notes: [lineNote('note-a', 'src/main.rs', 4)],
      error: undefined,
      loading: false,
    };
    const store = { getSnapshot: () => snapshot } as unknown as CurrentFileNotesStore;
    const createProviderWithState = () => new FrilVaultNotesProvider(
      store,
      async () => ({ root: { type: 'Directory', name: '', path: '', children: [] } }),
      () => '/tmp/workspace',
      () => true,
      state,
    );

    const provider = createProviderWithState();
    await provider.invalidateWorkspaceOverview('test-initial');
    const firstFile = (await provider.getChildren())
      .find((item) => item instanceof NotesFileHeaderItem) as NotesFileHeaderItem;
    const firstChildren = await provider.getChildren(firstFile);
    const firstGroupId = firstChildren[0]?.id;
    assert.ok(firstGroupId);
    assert.strictEqual(firstFile.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

    provider.setFileCollapsed(firstFile, true);
    await Promise.resolve();
    const nextProvider = createProviderWithState();
    await nextProvider.invalidateWorkspaceOverview('test-initial');
    const nextFile = (await nextProvider.getChildren())
      .find((item) => item instanceof NotesFileHeaderItem) as NotesFileHeaderItem;
    const nextChildren = await nextProvider.getChildren(nextFile);
    assert.strictEqual(nextFile.id, firstFile.id);
    assert.strictEqual(nextFile.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.strictEqual(nextChildren[0]?.id, firstGroupId);
  });
});

function createProvider(): FrilVaultNotesProvider {
  const store = new CurrentFileNotesStore(
    { listNotes: async () => [] } as unknown as import('../core/cliClient').CliClient,
    () => true,
    () => '/tmp/workspace',
  );

  return new FrilVaultNotesProvider(
    store,
    async () => ({
      root: { type: 'Directory', name: '', path: '', children: [] },
    }),
    () => '/tmp/workspace',
    () => true,
  );
}

function lineNote(id: string, sourceFile: string, line: number): NoteView {
  return {
    source_file: sourceFile,
    note: { id, content: 'content', anchor: { type: 'Line', line, column: 1 } },
  };
}

function createFakeTreeView(): vscode.TreeView<unknown> {
  const collapse = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<unknown>>();
  const expand = new vscode.EventEmitter<vscode.TreeViewExpansionEvent<unknown>>();
  return {
    onDidCollapseElement: collapse.event,
    onDidExpandElement: expand.event,
    dispose: () => {
      collapse.dispose();
      expand.dispose();
    },
  } as vscode.TreeView<unknown>;
}
