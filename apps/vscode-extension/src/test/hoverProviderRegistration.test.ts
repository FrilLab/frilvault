import * as assert from 'node:assert';

import { suite, test, teardown } from 'mocha';
import * as vscode from 'vscode';

import {
  disposeFrilVaultHoverProvider,
  isFrilVaultHoverProviderRegistered,
  registerFrilVaultHoverProvider,
  resetHoverProviderRegistrationForTests,
} from '../features/hover/register';
import { FrilVaultHoverProvider } from '../features/hover/hoverProvider';
import { CurrentFileNotesStore } from '../features/current-file/store';

suite('Hover provider registration', () => {
  teardown(() => {
    resetHoverProviderRegistrationForTests();
  });

  test('registers the hover provider only once', () => {
    let registerCalls = 0;
    const original = vscode.languages.registerHoverProvider;

    vscode.languages.registerHoverProvider = ((selector, provider) => {
      registerCalls += 1;
      assert.deepStrictEqual(selector, { scheme: 'file' });
      assert.ok(provider instanceof FrilVaultHoverProvider);
      return { dispose: () => undefined };
    }) as typeof vscode.languages.registerHoverProvider;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      const provider = createHoverProvider();

      registerFrilVaultHoverProvider(context as vscode.ExtensionContext, provider);
      registerFrilVaultHoverProvider(context as vscode.ExtensionContext, provider);

      assert.strictEqual(registerCalls, 1);
      assert.strictEqual(isFrilVaultHoverProviderRegistered(), true);
    } finally {
      vscode.languages.registerHoverProvider = original;
    }
  });

  test('disposes registration and allows a fresh register afterward', () => {
    let registerCalls = 0;
    const original = vscode.languages.registerHoverProvider;

    vscode.languages.registerHoverProvider = (() => {
      registerCalls += 1;
      return { dispose: () => undefined };
    }) as typeof vscode.languages.registerHoverProvider;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      const provider = createHoverProvider();

      registerFrilVaultHoverProvider(context as vscode.ExtensionContext, provider);
      disposeFrilVaultHoverProvider();

      assert.strictEqual(isFrilVaultHoverProviderRegistered(), false);

      registerFrilVaultHoverProvider(context as vscode.ExtensionContext, provider);

      assert.strictEqual(registerCalls, 2);
      assert.strictEqual(isFrilVaultHoverProviderRegistered(), true);
    } finally {
      vscode.languages.registerHoverProvider = original;
    }
  });

  test('subscription dispose clears registration state', () => {
    const original = vscode.languages.registerHoverProvider;
    vscode.languages.registerHoverProvider = (() => ({
      dispose: () => undefined,
    })) as typeof vscode.languages.registerHoverProvider;

    try {
      const context = { subscriptions: [] as vscode.Disposable[] };
      registerFrilVaultHoverProvider(context as vscode.ExtensionContext, createHoverProvider());

      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }

      assert.strictEqual(isFrilVaultHoverProviderRegistered(), false);
    } finally {
      vscode.languages.registerHoverProvider = original;
    }
  });
});

function createHoverProvider(): FrilVaultHoverProvider {
  const store = new CurrentFileNotesStore(
    { listNotes: async () => [] } as unknown as import('../core/cliClient').CliClient,
    () => true,
    () => '/tmp/workspace',
  );

  return new FrilVaultHoverProvider(store, () => true);
}
