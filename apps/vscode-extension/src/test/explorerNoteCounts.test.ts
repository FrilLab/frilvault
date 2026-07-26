import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { CliClient } from '../core/cliClient';
import {
  WorkspaceNoteCountStore,
  explorerNoteCountTooltip,
  formatExplorerNoteCountBadge,
} from '../features/explorer-badges/store';

suite('Explorer note count store', () => {
  test('loads per-file counts from the workspace index', async () => {
    const cliClient = {
      workspaceIndex: async () => ({
        version: 1,
        files: [
          { source_file: 'src/parser.rs', note_count: 5, exists: true },
          { source_file: 'src/main.rs', note_count: 2, exists: true },
          { source_file: 'src/empty.rs', note_count: 0, exists: true },
        ],
      }),
    } as unknown as CliClient;

    const store = new WorkspaceNoteCountStore(cliClient, () => '/tmp/workspace');

    await store.reload();

    assert.strictEqual(store.getFileCount('src/parser.rs'), 5);
    assert.strictEqual(store.getFileCount('src/main.rs'), 2);
    assert.strictEqual(store.getFolderCount('src'), 7);
    assert.strictEqual(store.getFileCount('src/empty.rs'), undefined);
  });

  test('clears cached counts when disabled', async () => {
    const store = new WorkspaceNoteCountStore(
      {
        workspaceIndex: async () => ({
          version: 1,
          files: [{ source_file: 'src/main.rs', note_count: 1, exists: true }],
        }),
      } as unknown as CliClient,
      () => '/tmp/workspace',
    );

    await store.reload();
    store.clear();

    assert.strictEqual(store.getFileCount('src/main.rs'), undefined);
    assert.strictEqual(store.getFolderCount('src'), undefined);
  });
});

suite('Explorer note count badges', () => {
  test('formats parenthesized count badges', () => {
    assert.strictEqual(formatExplorerNoteCountBadge(5), '(5)');
    assert.strictEqual(formatExplorerNoteCountBadge(18), '(9+)');
    assert.strictEqual(explorerNoteCountTooltip(1), '1 FrilVault note');
    assert.strictEqual(explorerNoteCountTooltip(3), '3 FrilVault notes');
  });
});
