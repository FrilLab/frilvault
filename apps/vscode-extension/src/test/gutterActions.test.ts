import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import type { CliClient } from '../core/cliClient';
import { GutterNoteActions } from '../features/decorations/gutterActions';
import type { NoteView } from '../types';

suite('Note viewer delete action', () => {
  test('shows content and tags when choosing a legacy note and cancellation keeps it', async () => {
    let deletedIds: string[] = [];
    let confirmation = '';
    let chooserDescriptions: string[] = [];
    const actions = createActions({
      onChoose: (items) => {
        chooserDescriptions = items.map((item) => item.description ?? '');
        return items.find((item) => item.label === 'parseSelected');
      },
      onConfirm: (message) => {
        confirmation = message;
        return undefined;
      },
      onDelete: (id) => {
        deletedIds.push(id);
      },
    });

    await actions.deleteNotesForViewer(
      ['first', 'selected'],
      'src/a.ts',
      'file:///tmp/workspace/src/a.ts',
    );

    assert.ok(chooserDescriptions.some((description) => description.includes('selected target')));
    assert.ok(chooserDescriptions.some((description) => description.includes('#keep')));
    assert.match(confirmation, /selected target/);
    assert.match(confirmation, /#keep/);
    assert.deepStrictEqual(deletedIds, []);
  });

  test('confirmation deletes only the selected note', async () => {
    const deletedIds: string[] = [];
    const invalidations: number[] = [];
    const actions = createActions({
      onChoose: (items) => items.find((item) => item.label === 'parseSelected'),
      onConfirm: () => 'Delete',
      onDelete: (id) => {
        deletedIds.push(id);
      },
      onInvalidate: () => invalidations.push(1),
    });

    await actions.deleteNotesForViewer(
      ['first', 'selected'],
      'src/a.ts',
      'file:///tmp/workspace/src/a.ts',
    );

    assert.deepStrictEqual(deletedIds, ['selected']);
    assert.deepStrictEqual(invalidations, [1]);
  });

  test('stale document context cannot delete a note from the current workspace', async () => {
    const deletedIds: string[] = [];
    let confirmations = 0;
    const actions = createActions({
      onChoose: (items) => items[0],
      onConfirm: () => {
        confirmations += 1;
        return 'Delete';
      },
      onDelete: (id) => deletedIds.push(id),
    });

    await actions.deleteNotesForViewer(
      ['selected'],
      'src/a.ts',
      'file:///tmp/other-workspace/src/a.ts',
    );

    assert.strictEqual(confirmations, 0);
    assert.deepStrictEqual(deletedIds, []);
  });
});

function createActions(input: {
  onChoose: (items: readonly (vscode.QuickPickItem & { note: NoteView })[]) =>
    vscode.QuickPickItem & { note: NoteView } | undefined;
  onConfirm: (message: string) => string | undefined;
  onDelete: (id: string) => void;
  onInvalidate?: () => void;
}): GutterNoteActions {
  const notes = [
    noteView('first', 'parseFirst', 'preserve this note', ['other']),
    noteView('selected', 'parseSelected', 'selected target', ['keep']),
  ];

  return new GutterNoteActions({
    cliClient: {
      listNotes: async (_workspaceRoot: string, _sourceFile: string) => notes,
      deleteNote: async (_workspaceRoot: string, _sourceFile: string, id: string) => input.onDelete(id),
    } as unknown as CliClient,
    registry: {} as never,
    getWorkspaceRoot: () => '/tmp/workspace',
    invalidateViews: async () => input.onInvalidate?.(),
    openInlineEditor: () => undefined,
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => {
      return input.onChoose(
        items as unknown as readonly (vscode.QuickPickItem & { note: NoteView })[],
      ) as unknown as T | undefined;
    },
    showWarningMessage: async (message) => input.onConfirm(message),
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message) => {
      throw new Error(message);
    },
  });
}

function noteView(id: string, name: string, content: string, tags: string[]): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id,
      content,
      anchor: { type: 'Symbol', name, kind: 'Function', line_hint: 1 },
      tags,
    },
    resolved: { line: 1, column: 1 },
  };
}
