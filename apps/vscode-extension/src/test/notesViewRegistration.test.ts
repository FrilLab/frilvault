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
    const original = vscode.window.registerTreeDataProvider;

    vscode.window.registerTreeDataProvider = ((viewId: string) => {
      registerCalls += 1;
      assert.strictEqual(viewId, VIEW_IDS.notes);
      return { dispose: () => undefined };
    }) as typeof vscode.window.registerTreeDataProvider;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      const provider = createProvider();

      registerNotesTreeDataProvider(context as vscode.ExtensionContext, provider);
      registerNotesTreeDataProvider(context as vscode.ExtensionContext, provider);

      assert.strictEqual(registerCalls, 1);
      assert.strictEqual(isNotesTreeDataProviderRegistered(), true);
    } finally {
      vscode.window.registerTreeDataProvider = original;
    }
  });

  test('disposes registration and allows a fresh register afterward', () => {
    let registerCalls = 0;
    const original = vscode.window.registerTreeDataProvider;

    vscode.window.registerTreeDataProvider = (() => {
      registerCalls += 1;
      return { dispose: () => undefined };
    }) as typeof vscode.window.registerTreeDataProvider;

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
      vscode.window.registerTreeDataProvider = original;
    }
  });

  test('subscription dispose clears registration state', () => {
    const original = vscode.window.registerTreeDataProvider;
    vscode.window.registerTreeDataProvider = (() => ({
      dispose: () => undefined,
    })) as typeof vscode.window.registerTreeDataProvider;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      registerNotesTreeDataProvider(context as vscode.ExtensionContext, createProvider());

      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }

      assert.strictEqual(isNotesTreeDataProviderRegistered(), false);
    } finally {
      vscode.window.registerTreeDataProvider = original;
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
        commands?: Array<{ command: string }>;
        menus?: {
          'view/item/context'?: Array<{ command: string }>;
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
    assert.ok(
      packageJson.contributes?.menus?.['view/item/context']?.some(
        (entry) => entry.command === COMMAND_IDS.notesPanelOpenNote,
      ),
    );
    assert.strictEqual(notesViewFocusCommand(), `${VIEW_IDS.notes}.focus`);
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
