import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { COMMAND_IDS } from '../constants/ids';
import { buildNoteUri } from '../features/decorations/gutterActions';
import { deduplicateNotesById } from '../features/presentation/deduplicateNotes';
import {
  buildNoteContentForClipboard,
  buildNoteMarkdownForClipboard,
} from '../features/presentation/noteClipboard';
import { buildEditorNotesHoverParts } from '../features/presentation/noteHover';
import { resolveNotesFromCache } from '../features/hover/resolveNotes';
import { RICH_HOVER_COMMANDS, formatRichNotesHoverParts } from '../features/hover/richHover';
import type { NoteView } from '../types';

suite('Hover presentation', () => {
  test('deduplicates notes by stable note ID', () => {
    const note = createLineNoteView('shared content', 'note-a');
    const duplicate = { ...note, source_file: 'src/other.ts' };

    const unique = deduplicateNotesById([note, duplicate]);

    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0]?.note.id, 'note-a');
  });

  test('keeps different notes that share identical content', () => {
    const left = createLineNoteView('same content', 'note-a');
    const right = createLineNoteView('same content', 'note-b');

    const unique = deduplicateNotesById([left, right]);

    assert.strictEqual(unique.length, 2);
  });

  test('resolveNotesFromCache returns each note once', () => {
    const note = createSymbolNoteView('ConfigKey', 'test context', { line: 1, column: 1 });
    const notes = [note, { ...note }];

    const matched = resolveNotesFromCache(notes, new vscode.Position(0, 0), 'ConfigKey');

    assert.strictEqual(matched.length, 1);
  });

  test('does not use the first tag as a hover title', () => {
    const parts = buildEditorNotesHoverParts(
      [
        {
          source_file: 'src/a.ts',
          note: {
            id: 'note-1',
            content: 'test context',
            anchor: { type: 'Symbol', name: 'ConfigKey', kind: 'Unknown', line_hint: 1 },
            tags: ['test tags'],
            updated_at: '2026-07-24T00:00:00Z',
            created_at: '2026-07-24T00:00:00Z',
          },
        },
      ],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';

    assert.doesNotMatch(content, /\*\*test tags\*\*/);
    assert.match(content, /test context/);
    assert.match(content, /Tags: \[#test tags\]\(command:frilvault\.searchNotesByTag/);
    assert.match(content, /Symbol: ConfigKey/);
    assert.doesNotMatch(content, /Unknown: ConfigKey/);
  });

  test('shows unresolved symbol warnings clearly', () => {
    const parts = buildEditorNotesHoverParts(
      [
        {
          source_file: 'src/a.ts',
          note: {
            id: 'note-1',
            content: 'test context',
            anchor: { type: 'Symbol', name: 'ConfigKey', kind: 'Unknown', line_hint: 1 },
            tags: ['test'],
            created_at: '2026-07-24T00:00:00Z',
            updated_at: '2026-07-24T00:00:00Z',
          },
        },
      ],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';

    assert.match(content, /Could not resolve the current declaration\./);
  });

  test('separates note content from action links', () => {
    const parts = formatRichNotesHoverParts(
      [createLineNoteView('test2', 'note-1')],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';
    const actions = parts.contents[1]?.value ?? '';

    assert.match(content, /test2/);
    assert.doesNotMatch(content, /Open Note/);
    assert.match(actions, /\[Open Note\]/);
    assert.match(actions, /\[Edit\]/);
    assert.match(actions, /\[Delete\]/);
    assert.match(actions, /\[Copy Link\]/);
    assert.deepStrictEqual(parts.contents[0]?.isTrusted, {
      enabledCommands: [COMMAND_IDS.searchNotesByTag],
    });
    assert.deepStrictEqual(parts.contents[1]?.isTrusted, {
      enabledCommands: [...RICH_HOVER_COMMANDS],
    });
  });

  test('buildNoteUri is the only clipboard payload for copy link', () => {
    const uri = buildNoteUri('note-1', '/tmp/workspace');

    assert.strictEqual(uri, 'frilvault://note/v1/note-1?workspace=%2Ftmp%2Fworkspace');
    assert.doesNotMatch(uri, /Open Note/);
  });

  test('renders each note section once for duplicate note IDs', () => {
    const note = createLineNoteView('test context', 'note-a');
    const parts = buildEditorNotesHoverParts(
      [note, { ...note }, { ...note, source_file: 'src/b.ts' }],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';
    const actions = parts.contents[1]?.value ?? '';

    assert.strictEqual(countOccurrences(content, '**FrilVault**'), 1);
    assert.strictEqual(countOccurrences(content, 'test context'), 1);
    assert.strictEqual(countOccurrences(content, 'Line 8:12'), 1);
    assert.strictEqual(countOccurrences(actions, '[Open Note]'), 1);
    assert.strictEqual(countOccurrences(actions, '[Copy Content]'), 1);
    assert.strictEqual(countOccurrences(actions, '[Copy Markdown]'), 1);
  });

  test('symbol note resolved to a line renders once from cache lookup', () => {
    const note = createSymbolNoteView('ConfigKey', 'test context', { line: 1, column: 1 });
    const matched = resolveNotesFromCache(
      [note, { ...note }, note],
      new vscode.Position(0, 0),
      'ConfigKey',
    );

    assert.strictEqual(matched.length, 1);

    const parts = buildEditorNotesHoverParts(
      matched,
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    const content = parts.contents[0]?.value ?? '';

    assert.strictEqual(countOccurrences(content, '**FrilVault**'), 1);
    assert.strictEqual(countOccurrences(content, 'test context'), 1);
    assert.strictEqual(countOccurrences(content, 'Symbol: ConfigKey'), 1);
  });

  test('copy note content excludes hover action labels', () => {
    const note = createLineNoteView('plain body', 'note-1');
    const content = buildNoteContentForClipboard(note);

    assert.strictEqual(content, 'plain body');
    assert.doesNotMatch(content, /Open Note/);
    assert.doesNotMatch(content, /Copy Link/);
  });

  test('copy note markdown excludes hover action labels', () => {
    const note = createLineNoteView('plain body', 'note-1');
    const markdown = buildNoteMarkdownForClipboard(note, '/tmp/workspace');

    assert.match(markdown, /# FrilVault/);
    assert.match(markdown, /plain body/);
    assert.match(markdown, /Line 8:12/);
    assert.match(markdown, /Tags: test/);
    assert.doesNotMatch(markdown, /Open Note/);
    assert.doesNotMatch(markdown, /Copy Link/);
    assert.doesNotMatch(markdown, /Copy Content/);
  });

  test('renders clickable escaped tags and truncates long tag lists', () => {
    const note = createLineNoteView('plain body', 'note-1');
    note.note.tags = ['todo', 'parser_[x]', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

    const parts = buildEditorNotesHoverParts(
      [note],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );
    const content = parts.contents[0]?.value ?? '';

    assert.match(content, /\[#todo\]\(command:frilvault\.searchNotesByTag/);
    assert.match(content, /#parser\\_\\\[x\\\]/);
    assert.match(content, /%22todo%22/);
    assert.match(content, /\+1 more/);
    assert.doesNotMatch(content, /#nine/);
  });

  test('does not render an empty tags section for untagged notes', () => {
    const note = createLineNoteView('plain body', 'note-1');
    note.note.tags = [];

    const parts = buildEditorNotesHoverParts(
      [note],
      '/tmp/workspace',
      'src/a.ts',
      800,
    );

    assert.doesNotMatch(parts.contents[0]?.value ?? '', /Tags:/);
  });
});

function createLineNoteView(content: string, id: string): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id,
      content,
      anchor: { type: 'Line', line: 8, column: 12 },
      tags: ['test'],
      created_at: '2026-07-24T00:00:00Z',
      updated_at: '2026-07-24T00:00:00Z',
    },
  };
}

function createSymbolNoteView(
  name: string,
  content: string,
  resolved?: { line: number; column: number },
): NoteView {
  return {
    source_file: 'src/a.ts',
    note: {
      id: `symbol-${name}`,
      content,
      anchor: { type: 'Symbol', name, kind: 'Function', line_hint: 1 },
      created_at: '2026-07-24T00:00:00Z',
      updated_at: '2026-07-24T00:00:00Z',
    },
    resolved,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  return haystack.split(needle).length - 1;
}
