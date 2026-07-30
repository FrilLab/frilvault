import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  aggregateNotesByLine,
  resolveNoteLine,
  sortNotesDeterministic,
} from '../features/decorations/aggregate';
import { buildNoteUri } from '../features/decorations/gutterActions';
import type { NoteView } from '../types';

suite('Gutter marker helpers', () => {
  test('aggregateNotesByLine skips unresolved symbol notes', () => {
    const notes = [
      createLineNoteView('src/a.ts', 4, 'first'),
      createSymbolNoteView('src/a.ts', 'MissingFn', 4, 'unresolved'),
      createSymbolNoteView('src/a.ts', 'fn', 4, 'resolved', undefined, {
        line: 4,
        column: 1,
      }),
    ];

    const groups = aggregateNotesByLine(notes, 20);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0]?.line, 3);
    assert.strictEqual(groups[0]?.notes.length, 2);
  });

  test('aggregateNotesByLine merges multiple notes on one line', () => {
    const notes = [
      createLineNoteView('src/a.ts', 4, 'first'),
      createSymbolNoteView('src/a.ts', 'fn', 4, 'second', undefined, {
        line: 4,
        column: 1,
      }),
      createLineNoteView('src/a.ts', 9, 'other line'),
    ];

    const groups = aggregateNotesByLine(notes, 20);

    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0]?.line, 3);
    assert.strictEqual(groups[0]?.notes.length, 2);
    assert.strictEqual(groups[1]?.line, 8);
  });

  test('sortNotesDeterministic prefers symbol notes and newest updates', () => {
    const notes = [
      createLineNoteView('src/a.ts', 1, 'line note', '2026-01-01T00:00:00Z'),
      createSymbolNoteView('src/a.ts', 'fn', 1, 'symbol note', '2026-01-02T00:00:00Z'),
    ];

    const sorted = sortNotesDeterministic(notes);

    assert.strictEqual(sorted[0]?.note.content, 'symbol note');
  });

  test('resolveNoteLine prefers resolved symbol coordinates', () => {
    const note = createSymbolNoteView('src/a.ts', 'fn', 1, 'symbol', undefined, {
      line: 8,
      column: 2,
    });

    assert.strictEqual(resolveNoteLine(note), 8);
  });

  test('buildNoteUri encodes workspace identity', () => {
    const uri = buildNoteUri('note-id', '/tmp/workspace');

    assert.strictEqual(
      uri,
      'frilvault://note/v1/note-id?workspace=%2Ftmp%2Fworkspace',
    );
  });
});

function createLineNoteView(
  sourceFile: string,
  line: number,
  content: string,
  updatedAt = '2026-01-01T00:00:00Z',
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${line}`,
      anchor: { type: 'Line', line, column: 1 },
      content,
      tags: [],
      updated_at: updatedAt,
      created_at: updatedAt,
    },
  };
}

function createSymbolNoteView(
  sourceFile: string,
  name: string,
  lineHint: number,
  content: string,
  updatedAt = '2026-01-01T00:00:00Z',
  resolved?: { line: number; column: number },
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${name}`,
      anchor: { type: 'Symbol', name, kind: 'Function', line_hint: lineHint },
      content,
      tags: [],
      updated_at: updatedAt,
      created_at: updatedAt,
    },
    resolved,
  };
}
