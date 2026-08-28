import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  buildNoteViewerItems,
  formatCollapsedSummary,
  groupNoteViewerItems,
  normalizeTags,
  type NoteViewerGroup,
} from '../features/note-viewer/noteViewerModel';
import type { NoteView } from '../types';

suite('Note viewer model', () => {
  test('one line note produces one viewer item', () => {
    const notes = [createLineNote('hello', 5)];
    const items = buildNoteViewerItems(notes, 'collapsed');

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].noteId, 'note-5');
    assert.strictEqual(items[0].anchorLine, 5);
    assert.strictEqual(items[0].anchorKind, 'line');
    assert.strictEqual(items[0].content, 'hello');
    assert.strictEqual(items[0].collapsed, true);
  });

  test('multiline note preserves line structure', () => {
    const notes = [createLineNote('line1\nline2\nline3', 10)];
    const items = buildNoteViewerItems(notes, 'expanded');

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].content, 'line1\nline2\nline3');
    assert.strictEqual(items[0].collapsed, false);
  });

  test('multiple notes on one anchor are grouped correctly', () => {
    const notes = [
      createLineNote('first', 7),
      createLineNote('second', 7, 'note-7b'),
    ];
    const items = buildNoteViewerItems(notes, 'collapsed');
    const groups = groupNoteViewerItems(items);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].anchorLine, 7);
    assert.strictEqual(groups[0].items.length, 2);
    assert.strictEqual(groups[0].totalCount, 2);
  });

  test('line and symbol anchors produce correct display location', () => {
    const notes = [
      createLineNote('line note', 4),
      createSymbolNote('parseFn', { line: 12, column: 3 }),
    ];
    const items = buildNoteViewerItems(notes, 'collapsed');

    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].anchorKind, 'line');
    assert.strictEqual(items[0].anchorLine, 4);
    assert.strictEqual(items[1].anchorKind, 'symbol');
    assert.strictEqual(items[1].anchorLine, 12);
  });

  test('duplicate notes are not rendered twice', () => {
    const note = createLineNote('same', 1);
    const items = buildNoteViewerItems([note, note], 'collapsed');
    const groups = groupNoteViewerItems(items);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].items.length, 1);
  });

  test('tags are normalized and limited in collapsed previews', () => {
    const notes = [createLineNote('content\nmore content', 1, 'n1', ['a', 'b', 'c', 'd'])];
    const items = buildNoteViewerItems(notes, 'collapsed');
    const groups = groupNoteViewerItems(items);
    const summary = formatCollapsedSummary(groups[0]);

    assert.ok(summary.includes('#a'));
    assert.ok(summary.includes('#b'));
    assert.ok(summary.includes('#c'));
    assert.ok(!summary.includes('#d'));
  });

  test('normalizes tag hashes and case-insensitive duplicates', () => {
    assert.deepStrictEqual(normalizeTags([' #todo', 'todo', '##Parser', '']), [
      'todo',
      'Parser',
    ]);
  });

  test('empty content is handled safely', () => {
    const notes = [createLineNote('', 3)];
    const items = buildNoteViewerItems(notes, 'collapsed');
    const groups = groupNoteViewerItems(items);

    assert.strictEqual(items.length, 1);
    assert.strictEqual(groups.length, 1);
    assert.doesNotThrow(() => formatCollapsedSummary(groups[0]));
  });

  test('unresolved symbol anchors are skipped', () => {
    const notes = [createSymbolNote('MissingFn')];
    const items = buildNoteViewerItems(notes, 'collapsed');

    assert.strictEqual(items.length, 0);
  });

  test('collapsed and expanded models are generated correctly', () => {
    const notes = [createLineNote('content', 2)];

    const collapsed = buildNoteViewerItems(notes, 'collapsed');
    assert.strictEqual(collapsed[0].collapsed, true);

    const expanded = buildNoteViewerItems(notes, 'expanded');
    assert.strictEqual(expanded[0].collapsed, false);
  });

  test('groups are sorted by anchorLine ascending', () => {
    const notes = [
      createLineNote('c', 10),
      createLineNote('a', 2),
      createLineNote('b', 5),
    ];
    const items = buildNoteViewerItems(notes, 'collapsed');
    const groups = groupNoteViewerItems(items);

    assert.strictEqual(groups.length, 3);
    assert.strictEqual(groups[0].anchorLine, 2);
    assert.strictEqual(groups[1].anchorLine, 5);
    assert.strictEqual(groups[2].anchorLine, 10);
  });

  test('formatCollapsedSummary single note with one-line content', () => {
    const group: NoteViewerGroup = {
      anchorLine: 1,
      items: [{
        noteId: 'x', sourceFile: 'f', title: 'X', content: 'Short content',
        tags: [], anchorLabel: 'Line 1', anchorLine: 1, anchorKind: 'line', collapsed: true,
      }],
      totalCount: 1,
    };

    const summary = formatCollapsedSummary(group);
    assert.ok(summary.startsWith('▶ Note'));
    assert.ok(summary.includes('Short content'));
  });

  test('formatCollapsedSummary multiple notes', () => {
    const group: NoteViewerGroup = {
      anchorLine: 1,
      items: [
        { noteId: 'a', sourceFile: 'f', title: 'A', content: 'a', tags: ['tag1'], anchorLabel: 'Line 1', anchorLine: 1, anchorKind: 'line', collapsed: true },
        { noteId: 'b', sourceFile: 'f', title: 'B', content: 'b', tags: ['tag2'], anchorLabel: 'Line 1', anchorLine: 1, anchorKind: 'line', collapsed: true },
      ],
      totalCount: 2,
    };

    const summary = formatCollapsedSummary(group);
    assert.ok(summary.includes('Notes (2)'));
  });

  test('items within a group are sorted by priority desc, then updated_at desc', () => {
    const notes = [
      createLineNote('low', 1, 'low', [], 0, '2026-01-01T00:00:00Z'),
      createLineNote('high', 1, 'high', [], 5, '2026-01-01T00:00:00Z'),
      createLineNote('medium', 1, 'medium', [], 2, '2026-06-01T00:00:00Z'),
    ];
    const items = buildNoteViewerItems(notes, 'collapsed');
    const groups = groupNoteViewerItems(items);

    assert.strictEqual(groups[0].items[0].noteId, 'high');
    assert.strictEqual(groups[0].items[1].noteId, 'medium');
    assert.strictEqual(groups[0].items[2].noteId, 'low');
  });
});

function createLineNote(
  content: string,
  line: number,
  id?: string,
  tags: string[] = [],
  priority?: number,
  updatedAt?: string,
): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id: id ?? `note-${line}`,
      content,
      anchor: { type: 'Line', line, column: 1 },
      tags,
      priority,
      updated_at: updatedAt ?? '2026-01-01T00:00:00Z',
    },
  };
}

function createSymbolNote(
  name: string,
  resolved?: { line: number; column: number },
): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id: `symbol-${name}`,
      content: `${name} note`,
      anchor: { type: 'Symbol', name, kind: 'Function', line_hint: 1 },
      updated_at: '2026-01-01T00:00:00Z',
    },
    resolved,
  };
}
