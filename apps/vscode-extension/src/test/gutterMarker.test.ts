import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import {
  aggregateNotesByLine,
  resolveNoteLine,
  sortNotesDeterministic,
  suppressBreakpointLineGroups,
} from '../features/decorations/aggregate';
import { sourceBreakpointLines } from '../features/decorations/decorator';
import { selectedNoteLine } from '../features/decorations/selectedNote';
import { buildNoteUri } from '../features/decorations/gutterActions';
import { formatGutterHoverSummary } from '../features/decorations/gutterHover';
import type { NoteView } from '../types';
import { resolveNoteRevealLine } from '../utils/file';

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

  test('source breakpoints suppress note markers and restore them when removed', () => {
    const uri = vscode.Uri.file('/tmp/frilvault-debug-fixture.ts');
    const documentUri = uri.toString();
    const notes = [
      createLineNoteView('debug-fixture.ts', 3, 'breakpoint line'),
      createLineNoteView('debug-fixture.ts', 5, 'note line'),
    ];
    const groups = aggregateNotesByLine(notes, 10);
    const breakpoints = [
      sourceBreakpoint(uri, 2, { enabled: true }),
      sourceBreakpoint(uri, 2, { enabled: false }),
      sourceBreakpoint(uri, 4, { condition: 'value > 0' }),
      sourceBreakpoint(uri, 4, { logMessage: 'value={value}' }),
    ];

    const breakpointLines = sourceBreakpointLines(documentUri, breakpoints);
    assert.deepStrictEqual([...breakpointLines].sort(), [2, 4]);
    assert.deepStrictEqual(
      suppressBreakpointLineGroups(groups, breakpointLines).map((group) => group.line),
      [],
    );
    assert.deepStrictEqual(
      suppressBreakpointLineGroups(groups, new Set()).map((group) => group.line),
      [2, 4],
      'removing breakpoints makes the note gutter markers eligible again',
    );
  });

  test('selected note highlight yields to breakpoints and keeps resolved navigation targets', () => {
    const uri = 'file:///tmp/source.rs';
    const selected = { documentUri: uri, line: 4 };
    assert.strictEqual(selectedNoteLine(selected, uri, 10, new Set()), 4);
    assert.strictEqual(selectedNoteLine(selected, uri, 10, new Set([4])), undefined);
    assert.strictEqual(selectedNoteLine(undefined, uri, 10, new Set()), undefined);

    const symbol = createSymbolNoteView('src/lib.rs', 'parse', 91, 'note', undefined, {
      line: 7,
      column: 2,
    });
    assert.strictEqual(resolveNoteRevealLine(symbol, 20), 6);
    assert.strictEqual(resolveNoteRevealLine(createSymbolNoteView('src/lib.rs', 'lost', 91, 'note'), 100), undefined);
    assert.strictEqual(resolveNoteRevealLine(createLineNoteView('src/lib.rs', 22, 'note'), 20), undefined);
  });

  test('formatGutterHoverSummary includes tags and action links', () => {
    const parts = formatGutterHoverSummary(
      [
        {
          ...createLineNoteView('src/a.ts', 2, 'hello world'),
          note: {
            ...createLineNoteView('src/a.ts', 2, 'hello world').note,
            tags: ['bug'],
            updated_at: '2026-01-02T00:00:00Z',
          },
        },
      ],
      'src/a.ts',
      '/tmp/workspace',
    );

    const combined = parts.map((part) => part.value).join('\n');

    assert.match(combined, /Line 2/);
    assert.match(combined, /Tags: \[#bug\]\(command:frilvault\.searchNotesByTag/);
    assert.match(combined, /\[Open Note\]/);
    assert.match(combined, /frilvault\.gutter\.viewNote/);
  });

  test('buildNoteUri encodes workspace identity', () => {
    const uri = buildNoteUri('note-id', '/tmp/workspace');

    assert.strictEqual(
      uri,
      'frilvault://note/v1/note-id?workspace=%2Ftmp%2Fworkspace',
    );
  });
});

function sourceBreakpoint(
  uri: vscode.Uri,
  line: number,
  options: Record<string, unknown>,
): vscode.Breakpoint {
  return new vscode.SourceBreakpoint(
    new vscode.Location(uri, new vscode.Position(line, 0)),
    options.enabled as boolean | undefined,
    options.condition as string | undefined,
    options.hitCondition as string | undefined,
    options.logMessage as string | undefined,
  );
}

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
