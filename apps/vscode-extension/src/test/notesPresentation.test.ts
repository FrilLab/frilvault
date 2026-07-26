import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test } from 'mocha';

import { COMMAND_IDS } from '../constants/ids';
import { buildWorkspaceNoteTree, groupNotesByAnchor } from '../features/notes-panel/presentation';
import { buildQuickPickItems } from '../features/notes-panel/quickPick';
import type { NoteView } from '../types';

suite('Notes presentation', () => {
  test('groups notes by symbol name, line anchor, and unresolved symbol anchors', () => {
    const notes = [
      createLineNoteView('src/sample.ts', 42, 1, 'line note'),
      createSymbolNoteView('src/sample.ts', 'CONFIG_KEYS', 10, 'resolved symbol', {
        line: 10,
        column: 1,
      }),
      createSymbolNoteView('src/sample.ts', 'MissingFn', 20, 'unresolved symbol'),
    ];

    const groups = groupNotesByAnchor(notes);

    assert.strictEqual(groups.symbolGroups.length, 1);
    assert.strictEqual(groups.symbolGroups[0]?.name, 'CONFIG_KEYS');
    assert.strictEqual(groups.lineNotes.length, 1);
    assert.strictEqual(groups.unresolvedNotes.length, 1);
    assert.strictEqual(groups.unresolvedNotes[0]?.note.content, 'unresolved symbol');
  });

  test('buildQuickPickItems orders symbol groups before line and unresolved notes', () => {
    const notes = [
      createLineNoteView('src/sample.ts', 42, 1, 'line note'),
      createSymbolNoteView('src/sample.ts', 'CONFIG_KEYS', 10, 'symbol note', {
        line: 10,
        column: 1,
      }),
      createSymbolNoteView('src/sample.ts', 'MissingFn', 20, 'unresolved symbol'),
    ];

    const items = buildQuickPickItems(notes, 'src/sample.ts');
    const labels = items.map((item) => item.label);

    assert.deepStrictEqual(labels, [
      'Symbol: CONFIG_KEYS',
      'symbol note',
      'Line Notes',
      'line note',
      'Unresolved Anchors',
      'unresolved symbol',
    ]);
  });

  test('buildWorkspaceNoteTree nests folder counts beside file counts', () => {
    const tree = buildWorkspaceNoteTree([
      { source_file: 'src/parser.rs', note_count: 5 },
      { source_file: 'src/main.rs', note_count: 2 },
      { source_file: 'README.md', note_count: 1 },
    ]);

    assert.strictEqual(tree.length, 2);
    assert.strictEqual(tree[0]?.kind, 'folder');
    assert.strictEqual(tree[1]?.kind, 'file');
    assert.strictEqual(tree[0]?.path, 'src');
    assert.strictEqual(tree[0]?.noteCount, 7);

    if (tree[0]?.kind !== 'folder') {
      assert.fail('expected src folder node');
    }

    assert.deepStrictEqual(
      tree[0].children.map((child) => `${child.kind}:${child.name}:${child.noteCount}`),
      ['file:main.rs:2', 'file:parser.rs:5'],
    );
    assert.strictEqual(tree[1]?.path, 'README.md');
    assert.strictEqual(tree[1]?.noteCount, 1);
  });

  test('package.json exposes the editor title action for current-file notes', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      contributes?: {
        commands?: Array<{ command: string; icon?: string }>;
        menus?: {
          'editor/title'?: Array<{ command: string; when?: string }>;
        };
      };
    };

    const command = packageJson.contributes?.commands?.find(
      (entry) => entry.command === COMMAND_IDS.showNotesForCurrentFile,
    );
    const editorTitleMenu = packageJson.contributes?.menus?.['editor/title'] ?? [];

    assert.ok(command);
    assert.strictEqual(command?.icon, '$(note)');
    assert.ok(
      editorTitleMenu.some(
        (entry) =>
          entry.command === COMMAND_IDS.showNotesForCurrentFile &&
          entry.when?.includes('frilvault.enabled'),
      ),
    );
  });
});

function createLineNoteView(
  sourceFile: string,
  line: number,
  column: number,
  content: string,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${line}-${column}`,
      anchor: {
        type: 'Line' as const,
        line,
        column,
      },
      content,
      created_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:00Z',
    },
  };
}

function createSymbolNoteView(
  sourceFile: string,
  name: string,
  lineHint: number,
  content: string,
  resolved?: { line: number; column: number },
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${name}`,
      anchor: {
        type: 'Symbol' as const,
        name,
        kind: 'Function',
        line_hint: lineHint,
      },
      content,
      created_at: '2026-06-09T00:00:00Z',
      updated_at: '2026-06-09T00:00:00Z',
    },
    resolved,
  };
}
