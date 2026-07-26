import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import type * as vscode from 'vscode';

import { CliClient } from '../core/cliClient';
import { CurrentFileNotesStore } from '../features/current-file/store';
import { createShowNotesForCurrentFileCommand } from '../features/notes-panel/command';
import {
  buildQuickPickItems,
  type NoteQuickPickItem,
} from '../features/notes-panel/quickPick';
import type { NoteView } from '../types';

suite('Show notes for current file command', () => {
  test('syncs the shared store and offers create-note action when empty', async () => {
    let syncCount = 0;
    let refreshCount = 0;
    let infoMessage = '';
    let createNoteRequested = false;

    const store = {
      syncActiveEditor: async () => {
        syncCount += 1;
      },
      getSnapshot: () => ({
        workspaceRoot: '/tmp/workspace',
        sourceFile: 'src/sample.ts',
        editorDocumentUri: 'file:///tmp/workspace/src/sample.ts',
        notes: [],
        error: undefined,
        loading: false,
      }),
    } as unknown as CurrentFileNotesStore;

    const command = createShowNotesForCurrentFileCommand({
      store,
      refreshNotesPanel: () => {
        refreshCount += 1;
      },
      getActiveEditor: () => createMockEditor('/tmp/workspace/src/sample.ts'),
      quickPick: createQuickPickDependencies(),
      showInformationMessage: async (message, ...items) => {
        infoMessage = message;

        if (items.includes('Add')) {
          createNoteRequested = true;
          return 'Add';
        }

        return undefined;
      },
      executeCommand: async (commandId) => {
        assert.strictEqual(commandId, 'frilvault.addNote');
      },
    });

    await command();

    assert.strictEqual(syncCount, 1);
    assert.strictEqual(refreshCount, 1);
    assert.strictEqual(infoMessage, 'No notes are attached to this file.');
    assert.strictEqual(createNoteRequested, true);
  });

  test('opens the current-file quick pick from the shared store snapshot', async () => {
    const note = createLineNoteView('src/sample.ts', 3, 1, 'line note');
    let quickPickShown = false;

    const store = {
      syncActiveEditor: async () => undefined,
      getSnapshot: () => ({
        workspaceRoot: '/tmp/workspace',
        sourceFile: 'src/sample.ts',
        editorDocumentUri: 'file:///tmp/workspace/src/sample.ts',
        notes: [note],
        error: undefined,
        loading: false,
      }),
    } as unknown as CurrentFileNotesStore;

    const command = createShowNotesForCurrentFileCommand({
      store,
      refreshNotesPanel: () => undefined,
      getActiveEditor: () => createMockEditor('/tmp/workspace/src/sample.ts'),
      quickPick: {
        ...createQuickPickDependencies(),
        createQuickPick: () => {
          quickPickShown = true;

          return createMockQuickPick([
            ...buildQuickPickItems([note], 'src/sample.ts'),
          ]);
        },
      },
    });

    await command();

    assert.strictEqual(quickPickShown, true);
  });
});

function createMockEditor(filePath: string): vscode.TextEditor {
  return {
    document: {
      uri: {
        scheme: 'file',
        toString: () => `file://${filePath}`,
        fsPath: filePath,
      },
    },
  } as vscode.TextEditor;
}

function createQuickPickDependencies(): {
  cliClient: CliClient;
  getWorkspaceRoot: () => string;
  invalidateViews: () => Promise<void>;
  openInlineEditor: (noteView: NoteView) => void;
} {
  return {
    cliClient: {
      deleteNote: async () => undefined,
    } as unknown as CliClient,
    getWorkspaceRoot: () => '/tmp/workspace',
    invalidateViews: async () => undefined,
    openInlineEditor: () => undefined,
  };
}

function createMockQuickPick(items: NoteQuickPickItem[]): vscode.QuickPick<NoteQuickPickItem> {
  const acceptHandlers: Array<() => void | Promise<void>> = [];
  const hideHandlers: Array<() => void> = [];

  return {
    title: '',
    placeholder: '',
    items,
    selectedItems: items.filter((item) => item.note).slice(0, 1),
    onDidAccept: (handler: () => void | Promise<void>) => {
      acceptHandlers.push(handler);
      return { dispose: () => undefined };
    },
    onDidTriggerItemButton: () => ({ dispose: () => undefined }),
    onDidHide: (handler: () => void) => {
      hideHandlers.push(handler);
      return { dispose: () => undefined };
    },
    show: () => {
      void acceptHandlers[0]?.();
      hideHandlers[0]?.();
    },
    hide: () => hideHandlers[0]?.(),
    dispose: () => undefined,
  } as unknown as vscode.QuickPick<NoteQuickPickItem>;
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
