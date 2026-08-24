import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { aggregateNotesByLine } from '../features/decorations/aggregate';
import {
  formatAnchorDetail,
  formatAnchorHeading,
  formatResolutionWarning,
  resolveNoteLine,
  toEditorNoteView,
  createInlinePreview,
} from '../features/presentation/editorNoteView';
import type { NoteView } from '../types';

suite('Editor note presentation', () => {
  test('preserves symbol anchor type after location resolution', () => {
    const note = createSymbolNoteView('parseYaml', { line: 12, column: 4 });
    const view = toEditorNoteView(note, '/tmp/workspace');

    assert.strictEqual(view.anchor.kind, 'symbol');
    assert.strictEqual(formatAnchorHeading(view.anchor), 'Symbol: parseYaml');
    assert.strictEqual(formatAnchorDetail(view.anchor), undefined);
    assert.strictEqual(formatResolutionWarning(view.anchor), undefined);
  });

  test('shows unresolved symbol status without treating it as a line note', () => {
    const note = createSymbolNoteView('MissingFn');
    const view = toEditorNoteView(note, '/tmp/workspace');

    assert.strictEqual(view.anchor.kind, 'symbol');
    assert.strictEqual(formatResolutionWarning(view.anchor), 'Could not resolve the current declaration.');
    assert.strictEqual(resolveNoteLine(note), undefined);
  });

  test('line notes keep line anchor metadata', () => {
    const note = createLineNoteView('Verify fallback', 42, 3);
    const view = toEditorNoteView(note, '/tmp/workspace');

    assert.strictEqual(view.anchor.kind, 'line');
    assert.strictEqual(formatAnchorHeading(view.anchor), 'Line 42:3');
  });

  test('aggregateNotesByLine skips unresolved symbol notes', () => {
    const notes = [
      createLineNoteView('line note', 4, 1),
      createSymbolNoteView('MissingFn'),
      createSymbolNoteView('ResolvedFn', { line: 4, column: 1 }),
    ];

    const groups = aggregateNotesByLine(notes, 20);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.line, 3);
    assert.strictEqual(groups[0]?.notes.length, 2);
  });

  test('createInlinePreview normalizes whitespace and truncates long previews', () => {
    const truncated = createInlinePreview('abcdefghijklmnop', 12);

    assert.strictEqual(truncated, 'abcdefghijkl…');
  });
});

function createLineNoteView(
  content: string,
  line: number,
  column: number,
): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id: `line-${line}`,
      content,
      anchor: { type: 'Line', line, column },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  };
}

function createSymbolNoteView(
  name: string,
  resolved?: { line: number; column: number },
): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id: `symbol-${name}`,
      content: `${name} note`,
      anchor: { type: 'Symbol', name, kind: 'Function', line_hint: 1 },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    resolved,
  };
}
