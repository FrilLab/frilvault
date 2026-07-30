import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { buildNoteViewerModel, groupNotesForViewer } from '../features/note-viewer/model';
import type { NoteView } from '../types';

suite('Note viewer model', () => {
  test('one line note produces one viewer item', () => {
    const blocks = buildNoteViewerModel(
      [createLineNoteView('note-1', 'single line', 4)],
      20,
      defaultOptions(),
    );

    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.collapsedText, '> Note · 1 lines');
  });

  test('multiline note preserves line structure when expanded', () => {
    const blocks = buildNoteViewerModel(
      [createLineNoteView('note-1', 'first line\n\nthird line', 4)],
      20,
      expandedOptions(),
    );

    assert.match(blocks[0]?.expandedText ?? '', /first line\n\nthird line/);
  });

  test('multiple notes on one anchor are grouped deterministically', () => {
    const groups = groupNotesForViewer(
      [
        createLineNoteView('note-2', 'second', 8),
        createLineNoteView('note-1', 'first', 8),
      ],
      30,
    );

    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0]?.notes.map((note) => note.note.id), ['note-1', 'note-2']);
  });

  test('line and resolved symbol anchors render at the correct line', () => {
    const groups = groupNotesForViewer(
      [
        createLineNoteView('line-note', 'line', 6),
        createSymbolNoteView('symbol-note', 'SymbolFn', 'symbol', { line: 9, column: 3 }),
      ],
      30,
    );

    assert.deepStrictEqual(groups.map((group) => group.line), [5, 8]);
  });

  test('duplicate notes are not rendered twice', () => {
    const note = createLineNoteView('duplicate', 'same note', 3);
    const groups = groupNotesForViewer([note, { ...note }], 20);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.notes.length, 1);
  });

  test('collapsed previews normalize and limit tags', () => {
    const blocks = buildNoteViewerModel(
      [createLineNoteView('tagged', 'body', 2, ['todo', '#parser', 'todo', 'perf'])],
      20,
      defaultOptions(),
    );

    assert.strictEqual(
      blocks[0]?.collapsedText,
      '> Note · 1 lines · #todo #parser #perf',
    );
  });

  test('empty content is handled safely', () => {
    const blocks = buildNoteViewerModel(
      [createLineNoteView('empty', '', 2)],
      20,
      expandedOptions(),
    );

    assert.match(blocks[0]?.expandedText ?? '', /\(empty note\)/);
  });

  test('unresolved anchors do not throw and are skipped', () => {
    const groups = groupNotesForViewer([createSymbolNoteView('missing', 'MissingFn', 'body')], 20);

    assert.strictEqual(groups.length, 0);
  });

  test('collapsed and expanded models are generated correctly', () => {
    const note = createLineNoteView('note-1', 'body', 2, ['todo']);
    const collapsed = buildNoteViewerModel([note], 20, defaultOptions())[0];
    const expanded = buildNoteViewerModel([note], 20, expandedOptions())[0];

    assert.strictEqual(collapsed?.expanded, false);
    assert.strictEqual(expanded?.expanded, true);
    assert.match(expanded?.expandedText ?? '', /^v Note/);
  });

  test('removed notes disappear after refresh', () => {
    const initial = groupNotesForViewer([createLineNoteView('note-1', 'body', 2)], 20);
    const refreshed = groupNotesForViewer([], 20);

    assert.strictEqual(initial.length, 1);
    assert.strictEqual(refreshed.length, 0);
  });
});

function defaultOptions() {
  return {
    defaultExpanded: false,
    isExpanded: () => false,
    maxPreviewLines: 3,
  };
}

function expandedOptions() {
  return {
    defaultExpanded: true,
    isExpanded: () => true,
    maxPreviewLines: 3,
  };
}

function createLineNoteView(
  id: string,
  content: string,
  line: number,
  tags: string[] = [],
): NoteView {
  return {
    source_file: 'src/sample.ts',
    note: {
      id,
      content,
      tags,
      anchor: { type: 'Line', line, column: 1 },
      created_at: '2026-07-30T00:00:00Z',
      updated_at: '2026-07-30T00:00:00Z',
    },
  };
}

function createSymbolNoteView(
  id: string,
  name: string,
  content: string,
  resolved?: { line: number; column: number },
): NoteView {
  return {
    source_file: 'src/sample.ts',
    note: {
      id,
      content,
      anchor: { type: 'Symbol', name, kind: 'Function', line_hint: 1 },
      created_at: '2026-07-30T00:00:00Z',
      updated_at: '2026-07-30T00:00:00Z',
    },
    resolved,
  };
}
