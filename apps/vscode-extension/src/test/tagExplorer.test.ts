import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test } from 'mocha';

import { VIEW_IDS, tagsViewActivationEvent } from '../constants/ids';
import { FrilVaultTagExplorerProvider } from '../features/tag-explorer/provider';
import {
  prepareTaggedNotes,
  prepareTagSummaries,
  tagNoteDescription,
} from '../features/tag-explorer/presentation';
import { TagExplorerTagItem } from '../features/tag-explorer/view';
import type { NoteView } from '../types';

suite('Tag explorer', () => {
  test('sorts tags alphabetically and removes duplicate entries', () => {
    const tags = prepareTagSummaries([
      { tag: 'todo', note_count: 2 },
      { tag: 'Architecture', note_count: 1 },
      { tag: 'TODO', note_count: 2 },
      { tag: 'performance', note_count: 3 },
    ]);

    assert.deepStrictEqual(
      tags.map((tag) => `${tag.tag}:${tag.note_count}`),
      ['Architecture:1', 'performance:3', 'todo:2'],
    );
  });

  test('shows counts and expands tags into file, anchor, and preview details', async () => {
    let tagLoads = 0;
    let noteLoads = 0;
    const notes = [
      createSymbolNote('src/parser.rs', 'parse', 'Improve error recovery', 12),
      createLineNote('src/main.rs', 7, 3, 'Replace temporary initialization'),
    ];
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        return [{ tag: 'todo', note_count: 2 }];
      },
      async (tag) => {
        noteLoads += 1;
        assert.strictEqual(tag, 'todo');
        return notes;
      },
    );

    const tags = await provider.getChildren();

    assert.strictEqual(tags.length, 1);
    assert.ok(tags[0] instanceof TagExplorerTagItem);
    assert.strictEqual(tags[0].label, 'todo');
    assert.strictEqual(tags[0].description, '(2)');

    const children = await provider.getChildren(tags[0]);

    assert.deepStrictEqual(children.map((item) => item.label), [
      'Replace temporary initialization',
      'Improve error recovery',
    ]);
    assert.strictEqual(children[0]?.description, 'src/main.rs · Line 7:3');
    assert.strictEqual(children[1]?.description, 'src/parser.rs · Symbol parse · Line 12');
    assert.strictEqual(children[0]?.command?.command, 'frilvault.notesPanel.openNote');

    await provider.getChildren(tags[0]);
    assert.strictEqual(tagLoads, 1);
    assert.strictEqual(noteLoads, 1);

    provider.refresh();
    await provider.getChildren();
    assert.strictEqual(tagLoads, 2);
  });

  test('supports line and symbol anchor descriptions and deterministic note ordering', () => {
    const line = createLineNote('src/b.rs', 2, 4, 'line note');
    const symbol = createSymbolNote('src/a.rs', 'run', 'symbol note', 8);
    const unresolved = createSymbolNote('src/a.rs', 'missing', 'unresolved note');

    assert.strictEqual(tagNoteDescription(line), 'src/b.rs · Line 2:4');
    assert.strictEqual(tagNoteDescription(symbol), 'src/a.rs · Symbol run · Line 8');
    assert.strictEqual(
      tagNoteDescription(unresolved),
      'src/a.rs · Symbol missing · Unresolved',
    );
    assert.deepStrictEqual(
      prepareTaggedNotes([line, symbol, unresolved]).map((note) => note.note.content),
      ['symbol note', 'unresolved note', 'line note'],
    );
  });

  test('shows a useful empty state when the workspace has no tagged notes', async () => {
    const provider = new FrilVaultTagExplorerProvider(
      async () => [],
      async () => [],
    );

    const children = await provider.getChildren();

    assert.strictEqual(children.length, 1);
    assert.match(String(children[0]?.label), /add tags when creating or editing a note/i);
  });

  test('package.json contributes and activates the tags view', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      activationEvents?: string[];
      contributes?: { views?: { explorer?: Array<{ id: string }> } };
    };

    assert.ok(
      packageJson.contributes?.views?.explorer?.some((view) => view.id === VIEW_IDS.tags),
    );
    assert.ok(packageJson.activationEvents?.includes(tagsViewActivationEvent()));
  });
});

function createLineNote(
  sourceFile: string,
  line: number,
  column: number,
  content: string,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${line}-${column}`,
      content,
      anchor: { type: 'Line', line, column },
    },
  };
}

function createSymbolNote(
  sourceFile: string,
  name: string,
  content: string,
  lineHint?: number,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${name}`,
      content,
      anchor: {
        type: 'Symbol',
        name,
        kind: 'Function',
        line_hint: lineHint,
      },
    },
  };
}
