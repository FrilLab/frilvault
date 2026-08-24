import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { sortNotesForHover, resolveNotesFromCache } from '../features/hover/resolveNotes';
import {
  formatRichNoteHover,
  formatRichNotesHoverParts,
  RICH_HOVER_COMMANDS,
  truncateMarkdownContent,
} from '../features/hover/richHover';
import type { NoteView } from '../types';

suite('Rich hover preview', () => {
  test('resolveNotesFromCache prefers symbol name matches over line notes', () => {
    const notes = [
      createLineNoteView('line note', '2026-01-01T00:00:00Z'),
      createSymbolNoteView('symbol note', '2026-01-02T00:00:00Z'),
    ];

    const matched = resolveNotesFromCache(notes, new vscode.Position(0, 0), 'myFn');

    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0]?.note.content, 'symbol note');
  });

  test('resolveNotesFromCache falls back to line notes', () => {
    const notes = [createLineNoteView('line note', '2026-01-01T00:00:00Z')];

    const matched = resolveNotesFromCache(notes, new vscode.Position(0, 0));

    assert.strictEqual(matched.length, 1);
    assert.strictEqual(matched[0]?.note.content, 'line note');
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
  };
}
