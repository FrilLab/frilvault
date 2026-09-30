import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { sortNotesForHover, resolveNotesFromCache } from '../features/hover/resolveNotes';
import { resolveNotesAtPosition } from '../features/hover/resolveNotes';
import {
  formatRichNoteHover,
  formatRichNotesHoverParts,
  RICH_HOVER_COMMANDS,
  truncateMarkdownContent,
} from '../features/hover/richHover';
import type { NoteView } from '../types';

suite('Rich hover preview', () => {
  test('resolveNotesFromCache includes a resolved declaration note and line note together', () => {
    const notes = [
      createLineNoteView('line note', '2026-01-01T00:00:00Z'),
      createSymbolNoteView('symbol note', '2026-01-02T00:00:00Z'),
    ];

    const matched = resolveNotesFromCache(notes, new vscode.Position(0, 0), {
      name: 'myFn',
      kind: 'function',
      line: 1,
      range: new vscode.Range(0, 0, 0, 4),
    });

    assert.strictEqual(matched.length, 2);
    assert.strictEqual(matched[0]?.note.content, 'symbol note');
    assert.strictEqual(matched[1]?.note.content, 'line note');
  });

  test('resolveNotesFromCache falls back to line notes', () => {
    const notes = [createLineNoteView('line note', '2026-01-01T00:00:00Z')];

    const matched = resolveNotesFromCache(notes, new vscode.Position(0, 0));

    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0]?.note.content, 'line note');
  });

  test('does not attach a symbol note without its resolved declaration match', () => {
    const notes = [createSymbolNoteView('symbol note', '2026-01-02T00:00:00Z')];

    assert.deepStrictEqual(
      resolveNotesFromCache(notes, new vscode.Position(2, 4), undefined, false),
      [],
    );
    assert.deepStrictEqual(
      resolveNotesFromCache(notes, new vscode.Position(0, 4), {
        name: 'otherFn',
        kind: 'function',
        line: 1,
        range: new vscode.Range(0, 0, 0, 8),
      }, false),
      [],
    );
  });

  test('symbol hover is limited to the declaration name and can include line notes', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'typescript',
      content: 'function parse() {\n  return 1;\n}\n',
    });
    const symbol = new vscode.DocumentSymbol(
      'parse',
      '',
      vscode.SymbolKind.Function,
      new vscode.Range(0, 0, 2, 1),
      new vscode.Range(0, 9, 0, 14),
    );
    const originalExecuteCommand = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (async <T>(command: string) =>
      command === 'vscode.executeDocumentSymbolProvider' ? [symbol] as T : undefined
    ) as typeof vscode.commands.executeCommand;

    const cancellation = new vscode.CancellationTokenSource();
    try {
      const notes: NoteView[] = [
        {
          source_file: 'src/a.ts',
          note: {
            id: 'symbol-note',
            content: 'symbol body',
            anchor: {
              type: 'Symbol',
              name: 'parse',
              kind: 'Function',
              signature: 'function parse() {',
              line_hint: 1,
            },
          },
          resolved: { line: 1, column: 1 },
        },
        {
          source_file: 'src/a.ts',
          note: {
            id: 'declaration-line-note',
            content: 'line body',
            anchor: { type: 'Line', line: 1, column: 1 },
          },
        },
        {
          source_file: 'src/a.ts',
          note: {
            id: 'body-line-note',
            content: 'body line body',
            anchor: { type: 'Line', line: 2, column: 1 },
          },
        },
      ];

      const declarationHover = await resolveNotesAtPosition(
        notes,
        document,
        new vscode.Position(0, 10),
        cancellation.token,
      );
      assert.deepStrictEqual(
        declarationHover?.notes.map((note) => note.note.id),
        ['symbol-note', 'declaration-line-note'],
      );
      assert.ok(declarationHover?.range.isEqual(new vscode.Range(0, 0, 0, 18)));

      const bodyHover = await resolveNotesAtPosition(
        notes,
        document,
        new vscode.Position(1, 4),
        cancellation.token,
      );
      assert.deepStrictEqual(bodyHover?.notes.map((note) => note.note.id), ['body-line-note']);
      assert.ok(bodyHover?.range.isEqual(new vscode.Range(1, 2, 1, 11)));
    } finally {
      cancellation.dispose();
      vscode.commands.executeCommand = originalExecuteCommand;
    }
  });

  test('sortNotesForHover prefers symbol notes and newest updates', () => {
    const notes = [
      createLineNoteView('line note', '2026-01-01T00:00:00Z'),
      createSymbolNoteView('symbol note', '2026-01-02T00:00:00Z'),
    ];

    const sorted = sortNotesForHover(notes);

    assert.strictEqual(sorted[0]?.note.content, 'symbol note');
  });

  test('sortNotesForHover uses note id as final tie-breaker', () => {
    const notes = [
      createLineNoteView('b', '2026-01-01T00:00:00Z', 'b-id'),
      createLineNoteView('a', '2026-01-01T00:00:00Z', 'a-id'),
    ];

    const sorted = sortNotesForHover(notes);

    assert.strictEqual(sorted[0]?.note.id, 'a-id');
  });

  test('formatRichNoteHover renders symbol anchor metadata without line kind labels', () => {
    const parts = formatRichNotesHoverParts(
      [
        {
          source_file: 'src/a.ts',
          note: {
            id: 'note-1',
            content: 'Optimize parser initialization.',
            anchor: { type: 'Symbol', name: 'parseYaml', kind: 'Function', line_hint: 4 },
            tags: ['TODO'],
            updated_at: '2026-07-24T00:00:00Z',
            created_at: '2026-07-24T00:00:00Z',
          },
          resolved: { line: 4, column: 1 },
        },
      ],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';

    assert.match(content, /Symbol: parseYaml/);
    assert.doesNotMatch(content, /Kind:/);
    assert.doesNotMatch(content, /Type: Line/);
    assert.doesNotMatch(content, /Function: parseYaml/);
  });

  test('formatRichNoteHover renders markdown metadata and fenced code', () => {
    const parts = formatRichNotesHoverParts(
      [
        {
          source_file: 'src/a.ts',
          note: {
            id: 'note-1',
            content: '# Title\n\n```ts\nconst value = 1;\n```',
            anchor: { type: 'Line', line: 4, column: 2 },
            tags: ['bug'],
            updated_at: '2026-01-02T00:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        },
      ],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';
    const actions = parts.contents[1];

    assert.match(content, /Line 4:2/);
    assert.match(content, /Tags: \[#bug\]\(command:frilvault\.searchNotesByTag/);
    assert.match(content, /```ts/);
    assert.strictEqual(content.includes('[Edit]'), false);
    assert.match(actions?.value ?? '', /\[Edit\]/);
    assert.match(actions?.value ?? '', /\[Delete\]/);
    assert.match(actions?.value ?? '', /\[Copy Link\]/);
    assert.strictEqual(actions?.supportHtml, false);
    assert.ok(typeof actions?.isTrusted === 'object' && actions?.isTrusted !== null);
    if (typeof actions?.isTrusted === 'object' && actions?.isTrusted !== null) {
      assert.deepStrictEqual(actions.isTrusted.enabledCommands, [...RICH_HOVER_COMMANDS]);
    }
  });

  test('formatRichNoteHover adds Open Note link for long content', () => {
    const markdown = formatRichNoteHover(
      createLineNoteView('x'.repeat(900), '2026-01-01T00:00:00Z'),
      '/tmp/workspace',
      'src/a.ts',
      200,
    );

    assert.match(markdown.value, /Open Note/);
    assert.match(markdown.value, /frilvault\.gutter\.viewNote/);
    assert.doesNotMatch(markdown.value, /command:evil/);
  });

  test('truncateMarkdownContent avoids cutting inside fenced code', () => {
    const content = 'Intro\n\n```ts\nconst value = 1;\n```\nTail';
    const truncated = truncateMarkdownContent(content, 20);

    assert.strictEqual(truncated.truncated, true);
    assert.doesNotMatch(truncated.preview, /```ts/);
  });

  test('formatRichNoteHover escapes unsafe inline metadata', () => {
    const markdown = formatRichNoteHover(
      {
        source_file: 'src/a.ts',
        note: {
          id: 'note-1',
          content: 'safe body',
          anchor: { type: 'Symbol', name: 'run<script>', kind: 'Function', line_hint: 1 },
          tags: ['a<b>'],
          updated_at: '2026-01-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      },
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    assert.doesNotMatch(markdown.value, /<script>/);
    assert.match(markdown.value, /run\\<script\\>/);
  });
});

function createLineNoteView(
  content: string,
  updatedAt: string,
  id = 'line-id',
): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id,
      content,
      anchor: { type: 'Line', line: 1, column: 1 },
      created_at: updatedAt,
      updated_at: updatedAt,
    },
  };
}

function createSymbolNoteView(content: string, updatedAt: string): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id: 'symbol-id',
      content,
      anchor: { type: 'Symbol', name: 'myFn', kind: 'Function', line_hint: 1 },
      created_at: updatedAt,
      updated_at: updatedAt,
    },
    resolved: { line: 1, column: 1 },
  };
}
