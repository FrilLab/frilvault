import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  createEditDraft,
  createLineCreateDraft,
  createSymbolCreateDraft,
  parseTagsText,
  validateInlineNoteForm,
} from '../features/inline-editor/draft';
import { renderPanelHtml } from '../features/inline-editor/panel';
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

  test('short-note editor uses compact location and responsive growing content input', () => {
    const draft = createLineCreateDraft({
      workspaceRoot: '/tmp/workspace',
      sourceFile: 'src/main.rs',
      line: 4,
      column: 2,
    });
    const html = renderPanelHtml(draft);

    assert.match(html, /aria-label="Note location">src\/main\.rs · L4/);
    assert.match(html, /min-height: calc\(1\.4em \* 4 \+ 16px\)/);
    assert.match(html, /max-height: 50vh/);
    assert.match(html, /max-width: 720px/);
    assert.match(html, /function resizeContent\(\)/);
    assert.doesNotMatch(html, /min-height: 220px|tag-preview|tag-chip/);
  });

  test('editing an unresolved Symbol does not present its saved line hint as verified', () => {
    const draft = createEditDraft({
      source_file: 'src/main.rs',
      note: {
        id: 'unresolved-symbol',
        content: 'note',
        anchor: { type: 'Symbol', name: 'missing', kind: 'Function', line_hint: 90 },
      },
    }, '/tmp/workspace');

    assert.strictEqual(draft.anchorSummary, 'Symbol missing · Unresolved');
    assert.doesNotMatch(draft.anchorSummary, /90/);
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
