import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { CliClient } from '../core/cliClient';
import { CurrentFileNotesStore } from '../features/current-file/store';
import { isActiveEditorDocumentSave } from '../features/current-file/saveRefresh';
import { FrilVaultNotesProvider } from '../features/notes-panel/provider';
import { NotesFileHeaderItem } from '../features/notes-panel/view';
import type { NoteView } from '../types';

suite('CurrentFileNotesStore', () => {
  test('coalesces concurrent refreshes for the active editor', async () => {
    let callCount = 0;
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => {
        callCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [createLineNoteView(sourceFile, 1, 1, 'current note')];
      },
    } as unknown as CliClient;

    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');
    const editor = createMockEditor('/tmp/workspace/src/sample.ts');

    const firstLoad = store.syncActiveEditor(editor);
    const secondLoad = store.syncActiveEditor(editor);

    await Promise.all([firstLoad, secondLoad]);

    assert.strictEqual(callCount, 1);
    assert.strictEqual(store.getSnapshot().notes.length, 1);
    assert.strictEqual(store.getSnapshot().notes[0]?.note.content, 'current note');
  });

  test('a mutation during a read schedules one follow-up and returns persisted state', async () => {
    let callCount = 0;
    let finishFirstRead: ((notes: NoteView[]) => void) | undefined;
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => {
        callCount += 1;

        if (callCount === 1) {
          markFirstReadStarted();
          return new Promise<NoteView[]>((resolve) => {
            finishFirstRead = resolve;
          });
        }

        return [createLineNoteView(sourceFile, 1, 1, 'latest persisted note')];
      },
    } as unknown as CliClient;
    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');
    const editor = createMockEditor('/tmp/workspace/src/sample.ts');

    const initialLoad = store.syncActiveEditor(editor);
    await firstReadStarted;
    const mutationRefresh = store.invalidateAfterMutation(editor);
    finishFirstRead?.([createLineNoteView('src/sample.ts', 1, 1, 'outdated result')]);
    await Promise.all([initialLoad, mutationRefresh]);

    assert.strictEqual(callCount, 2);
    assert.strictEqual(store.getSnapshot().notes[0]?.note.content, 'latest persisted note');
  });

  test('a late response from a previous file cannot replace the active file', async () => {
    let finishFirstRead: ((notes: NoteView[]) => void) | undefined;
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => {
        if (sourceFile === 'src/first.ts') {
          return new Promise<NoteView[]>((resolve) => {
            finishFirstRead = resolve;
          });
        }

        return [createLineNoteView(sourceFile, 2, 1, 'second file note')];
      },
    } as unknown as CliClient;
    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');

    const firstLoad = store.syncActiveEditor(createMockEditor('/tmp/workspace/src/first.ts'));
    await store.syncActiveEditor(createMockEditor('/tmp/workspace/src/second.ts'));
    finishFirstRead?.([createLineNoteView('src/first.ts', 1, 1, 'stale first file note')]);
    await firstLoad;

    assert.strictEqual(store.getSnapshot().sourceFile, 'src/second.ts');
    assert.strictEqual(store.getSnapshot().notes[0]?.note.content, 'second file note');
  });

  test('a late response from a previously selected vault is discarded', async () => {
    const configuration = vscode.workspace.getConfiguration('frilvault');
    const previousVaultPath = configuration.get<string>('vaultPath', '');
    await configuration.update(
      'vaultPath',
      '/tmp/frilvault-vault-before-switch',
      vscode.ConfigurationTarget.Global,
    );

    let callCount = 0;
    let markFirstReadStarted!: () => void;
    let finishFirstRead: ((notes: NoteView[]) => void) | undefined;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => {
        callCount += 1;

        if (callCount === 1) {
          markFirstReadStarted();
          return new Promise<NoteView[]>((resolve) => {
            finishFirstRead = resolve;
          });
        }

        return [createLineNoteView(sourceFile, 1, 1, 'new vault note')];
      },
    } as unknown as CliClient;
    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');
    const editor = createMockEditor('/tmp/workspace/src/sample.ts');

    try {
      const firstLoad = store.syncActiveEditor(editor);
      await firstReadStarted;
      await configuration.update(
        'vaultPath',
        '/tmp/frilvault-vault-after-switch',
        vscode.ConfigurationTarget.Global,
      );
      await store.syncActiveEditor(editor);
      finishFirstRead?.([createLineNoteView('src/sample.ts', 1, 1, 'old vault note')]);
      await firstLoad;

      assert.strictEqual(callCount, 2);
      assert.strictEqual(store.getSnapshot().notes[0]?.note.content, 'new vault note');
    } finally {
      store.dispose();
      await configuration.update('vaultPath', previousVaultPath, vscode.ConfigurationTarget.Global);
    }
  });

  test('coalesces same-file refreshes and keeps the current notes visible while loading', async () => {
    let callCount = 0;
    let finishRefresh: ((notes: NoteView[]) => void) | undefined;
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => {
        callCount += 1;

        if (callCount === 1) {
          return [createLineNoteView(sourceFile, 1, 1, 'visible note')];
        }

        return new Promise<NoteView[]>((resolve) => {
          finishRefresh = resolve;
        });
      },
      workspaceExplorer: async () => ({
        root: { type: 'Directory' as const, name: '', path: '', children: [] },
      }),
    } as unknown as CliClient;

    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');
    const editor = createMockEditor('/tmp/workspace/src/sample.ts');
    await store.syncActiveEditor(editor);
    const provider = new FrilVaultNotesProvider(
      store,
      async () => ({ root: { type: 'Directory', name: '', path: '', children: [] } }),
      () => '/tmp/workspace',
    );

    const firstRefresh = store.syncActiveEditor(editor);
    const duplicateRefresh = store.syncActiveEditor(editor);
    const visibleDuringRefresh = await provider.getChildren();
    const activeFile = visibleDuringRefresh.find((item) => item instanceof NotesFileHeaderItem);

    assert.strictEqual(callCount, 2, 'duplicate invalidations should share one CLI read');
    assert.strictEqual(store.getSnapshot().loading, false);
    assert.ok(activeFile instanceof NotesFileHeaderItem);
    assert.strictEqual(activeFile.label, 'src/sample.ts');
    assert.strictEqual(store.getSnapshot().notes[0]?.note.content, 'visible note');
    assert.strictEqual(
      store.notesForDocument({
        uri: { toString: () => 'file:///tmp/workspace/src/sample.ts' },
      } as import('vscode').TextDocument)[0]?.note.content,
      'visible note',
    );

    finishRefresh?.([createLineNoteView('src/sample.ts', 1, 1, 'visible note')]);
    await Promise.all([firstRefresh, duplicateRefresh]);
    assert.strictEqual(callCount, 2);
  });

  test('unchanged same-context results do not emit another presentation update', async () => {
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => [
        createLineNoteView(sourceFile, 1, 1, 'stable note'),
      ],
    } as unknown as CliClient;
    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');
    const editor = createMockEditor('/tmp/workspace/src/sample.ts');
    let changes = 0;
    store.onDidChange(() => {
      changes += 1;
    });

    await store.syncActiveEditor(editor);
    const changesAfterInitialLoad = changes;
    await store.syncActiveEditor(editor);

    assert.strictEqual(changes, changesAfterInitialLoad);
    store.dispose();
  });

  test('returns empty notes when the CLI fails', async () => {
    const cliClient = {
      listNotes: async () => {
        throw new Error('missing vault');
      },
    } as unknown as CliClient;

    const store = new CurrentFileNotesStore(cliClient, () => true, () => '/tmp/workspace');
    await store.syncActiveEditor(createMockEditor('/tmp/workspace/src/sample.ts'));

    assert.deepStrictEqual(store.getSnapshot().notes, []);
    assert.match(store.getSnapshot().error ?? '', /missing vault/);
  });

  test('clears notes when FrilVault is disabled', async () => {
    let enabled = true;
    const cliClient = {
      listNotes: async (_workspaceRoot: string, sourceFile: string) => [
        createLineNoteView(sourceFile, 1, 1, 'enabled note'),
      ],
    } as unknown as CliClient;

    const store = new CurrentFileNotesStore(cliClient, () => enabled, () => '/tmp/workspace');
    await store.syncActiveEditor(createMockEditor('/tmp/workspace/src/sample.ts'));

    assert.strictEqual(store.getSnapshot().notes.length, 1);

    enabled = false;
    store.clear();

    assert.strictEqual(store.getSnapshot().notes.length, 0);
  });

  test('unrelated saved documents do not refresh the current file', () => {
    const activeEditor = createMockEditor('/tmp/workspace/src/sample.ts');
    const sameDocument = {
      uri: { toString: () => 'file:///tmp/workspace/src/sample.ts' },
    } as import('vscode').TextDocument;
    const unrelatedDocument = {
      uri: { toString: () => 'file:///tmp/workspace/src/other.ts' },
    } as import('vscode').TextDocument;

    assert.strictEqual(isActiveEditorDocumentSave(sameDocument, activeEditor), true);
    assert.strictEqual(isActiveEditorDocumentSave(unrelatedDocument, activeEditor), false);
    assert.strictEqual(isActiveEditorDocumentSave(sameDocument, undefined), false);
  });
});

function createMockEditor(filePath: string): import('vscode').TextEditor {
  return {
    document: {
      uri: {
        scheme: 'file',
        toString: () => `file://${filePath}`,
        fsPath: filePath,
      },
    },
  } as import('vscode').TextEditor;
}

function createLineNoteView(
  sourceFile: string,
  line: number,
  column: number,
  content: string,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${line}-${column}`,
      anchor: {
        type: 'Line' as const,
        line,
        column,
      },
      content,
      created_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:00Z',
    },
  };
}
