import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  createEditDraft,
  createLineCreateDraft,
  createSymbolCreateDraft,
  parseTagsText,
  validateInlineNoteForm,
} from '../features/inline-editor/draft';
import type { NoteView } from '../types';

suite('Inline note editor draft', () => {
  test('validateInlineNoteForm rejects empty content', () => {
    assert.strictEqual(
      validateInlineNoteForm({ content: '   ', tagsText: '' }),
      'Note content is required.',
    );
  });

  test('parseTagsText splits comma-separated tags', () => {
    assert.deepStrictEqual(parseTagsText('bug, refactor , docs'), [
      'bug',
      'refactor',
      'docs',
    ]);
  });

  test('parseTagsText normalizes hashes and prevents case-insensitive duplicates', () => {
    assert.deepStrictEqual(
      parseTagsText(' #Performance, performance, # permission, new-tag '),
      ['Performance', 'permission', 'new-tag'],
    );
  });

  test('createEditDraft preserves undo snapshot and updated_at', () => {
    const noteView = createLineNoteView('hello', ['bug']);

    const draft = createEditDraft(noteView, '/tmp/workspace');

    assert.strictEqual(draft.mode, 'edit');
    assert.strictEqual(draft.content, 'hello');
    assert.strictEqual(draft.tagsText, '#bug');
    assert.strictEqual(draft.expectedUpdatedAt, '2026-01-02T00:00:00Z');
    assert.deepStrictEqual(draft.undoSnapshot?.tags, ['bug']);
  });

  test('createSymbolCreateDraft captures symbol metadata', () => {
    const draft = createSymbolCreateDraft({
      workspaceRoot: '/tmp/workspace',
      sourceFile: 'src/main.rs',
      symbolName: 'main',
      symbolKind: 'function',
      symbolSignature: 'fn main()',
      lineHint: 3,
    });

    assert.strictEqual(draft.kind, 'Symbol');
    assert.match(draft.anchorSummary, /main/);
  });

  test('createLineCreateDraft captures cursor anchor', () => {
    const draft = createLineCreateDraft({
      workspaceRoot: '/tmp/workspace',
      sourceFile: 'src/main.rs',
      line: 4,
      column: 2,
    });

    assert.strictEqual(draft.line, 4);
    assert.strictEqual(draft.column, 2);
  });
});

function createLineNoteView(content: string, tags: string[]): NoteView {
  return {
    source_file: 'src/main.rs',
    note: {
      id: 'note-id',
      content,
      tags,
      updated_at: '2026-01-02T00:00:00Z',
      anchor: { type: 'Line', line: 4, column: 2 },
    },
  };
}
