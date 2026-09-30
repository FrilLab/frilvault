import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import type { CliClient } from '../core/cliClient';
import { InlineNoteEditor } from '../features/inline-editor/editor';
import type { InlineNoteDraft } from '../features/inline-editor/draft';
import type { InlineNotePanelLike } from '../features/inline-editor/panel';
import type { NoteView } from '../types';

suite('Inline note add or edit by anchor', () => {
  test('edits the exact existing line anchor and creates at an empty anchor', async () => {
    const existing = noteView('line-target', { type: 'Line', line: 6, column: 3 }, 'existing');
    const otherLinePosition = noteView('other-column', { type: 'Line', line: 6, column: 4 }, 'other');
    const symbol = noteView('same-line-symbol', {
      type: 'Symbol', name: 'parse', kind: 'Function', signature: 'fn parse()', line_hint: 6,
    }, 'symbol');
    const setup = createEditor([existing, otherLinePosition, symbol]);

    try {
      await setup.editor.openCreateOrEditAt(
        'src/a.rs',
        { type: 'Line', line: 6, column: 3 },
        6,
      );
      assert.strictEqual(setup.opened[0]?.mode, 'edit');
      assert.strictEqual(setup.opened[0]?.noteId, 'line-target');

      const staleContext = createEditor([existing]);
      try {
        await staleContext.editor.openCreateOrEditAt(
          'src/a.rs',
          { type: 'Line', line: 6, column: 3 },
          6,
          'file:///tmp/other/src/a.rs',
        );
        assert.strictEqual(staleContext.opened.length, 0);
      } finally {
        staleContext.editor.dispose();
      }

      const emptyAnchor = createEditor([]);
      try {
        await emptyAnchor.editor.openCreateOrEditAt(
          'src/a.rs',
          { type: 'Line', line: 9, column: 2 },
          9,
        );
        assert.strictEqual(emptyAnchor.opened[0]?.mode, 'create');
        assert.strictEqual(emptyAnchor.opened[0]?.line, 9);
        assert.strictEqual(emptyAnchor.opened[0]?.column, 2);
      } finally {
        emptyAnchor.editor.dispose();
      }
    } finally {
      setup.editor.dispose();
    }
  });

  test('symbol identity ignores a moved line hint and offers a preview chooser for legacy notes', async () => {
    const first = noteView('first', {
      type: 'Symbol', name: 'parse', kind: 'Function', signature: 'fn parse()', line_hint: 3,
    }, 'first legacy note');
    const selected = noteView('selected', {
      type: 'Symbol', name: 'parse', kind: 'Function', signature: 'fn parse()', line_hint: 18,
    }, 'selected legacy note');
    const line = noteView('line-note', { type: 'Line', line: 18, column: 1 }, 'line note');
    let chooserDescriptions: string[] = [];
    const setup = createEditor([first, selected, line], (items) => {
      chooserDescriptions = items.map((item) => item.description ?? '');
      return items.find((item) => item.description?.includes('selected legacy note'));
    });

    try {
      await setup.editor.openCreateOrEditAt(
        'src/a.rs',
        { type: 'Symbol', name: 'parse', kind: 'Function', signature: 'fn parse()', line_hint: 18 },
        18,
      );

      assert.ok(chooserDescriptions.some((description) => description.includes('first legacy note')));
      assert.ok(chooserDescriptions.some((description) => description.includes('selected legacy note')));
      assert.strictEqual(setup.opened[0]?.noteId, 'selected');
    } finally {
      setup.editor.dispose();
    }
  });
});

function createEditor(
  notes: NoteView[],
  choose?: <T extends vscode.QuickPickItem>(items: readonly T[]) => T | undefined,
): { editor: InlineNoteEditor; opened: InlineNoteDraft[] } {
  const opened: InlineNoteDraft[] = [];
  const panel: InlineNotePanelLike = {
    open: (_context, draft) => opened.push(draft),
    updateDraft: () => undefined,
    close: () => undefined,
    isOpen: () => opened.length > 0,
  };
  const editor = new InlineNoteEditor({
    cliClient: {
      listNotes: async () => notes,
      tagList: async () => [],
    } as unknown as CliClient,
    getWorkspaceRoot: () => '/tmp/workspace',
    refreshNoteState: async () => undefined,
    panel,
    showQuickPick: choose
      ? async <T extends vscode.QuickPickItem>(items: readonly T[]) => choose(items)
      : undefined,
  });
  editor.register({
    subscriptions: [],
    workspaceState: {
      get: () => undefined,
      update: async () => undefined,
    },
  } as unknown as vscode.ExtensionContext);

  return { editor, opened };
}

function noteView(id: string, anchor: NoteView['note']['anchor'], content: string): NoteView {
  return {
    source_file: 'src/a.rs',
    note: { id, content, anchor, tags: ['tag'] },
    resolved: anchor.type === 'Symbol' ? { line: anchor.line_hint ?? 1, column: 1 } : undefined,
  };
}
