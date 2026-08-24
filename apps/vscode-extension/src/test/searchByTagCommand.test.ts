import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test } from 'mocha';

import { COMMAND_IDS } from '../constants/ids';
import type { CliClient, SearchNotesInput } from '../core/cliClient';
import {
  buildTagSearchQuickPickItems,
  createSearchByTagCommand,
  type SearchQuickPickItem,
} from '../features/search/command';
import type { NoteView } from '../types';

suite('Search notes by tag command', () => {
  test('searches by tag, shows source and anchors, and reveals the selected note', async () => {
    const lineNote = createLineNote();
    const symbolNote = createSymbolNote();
    let searchInput: SearchNotesInput | undefined;
    let pickedItems: SearchQuickPickItem[] = [];
    let revealed: NoteView | undefined;

    const command = createSearchByTagCommand({
      cliClient: {
        searchNotes: async (input) => {
          searchInput = input;
          return [lineNote, symbolNote];
        },
      } as Pick<CliClient, 'searchNotes'>,
      getWorkspaceRoot: () => '/workspace',
      showInputBox: async () => '#todo',
      showQuickPick: async (items) => {
        pickedItems = items;
        return items[1];
      },
      revealNote: async (note) => {
        revealed = note;
      },
    });

    await command();

    assert.deepStrictEqual(searchInput, {
      workspaceRoot: '/workspace',
      tag: '#todo',
    });
    assert.match(pickedItems[0]?.description ?? '', /src\/main\.rs · Line 3/);
    assert.match(pickedItems[1]?.description ?? '', /src\/lib\.rs · Line 12 · parse/);
    assert.strictEqual(pickedItems[0]?.detail, 'Tags: #todo  #urgent');
    assert.strictEqual(revealed, symbolNote);
  });

  test('shows a clear empty state', async () => {
    let infoMessage = '';
    let quickPickShown = false;

    const command = createSearchByTagCommand({
      cliClient: {
        searchNotes: async () => [],
      } as Pick<CliClient, 'searchNotes'>,
      getWorkspaceRoot: () => '/workspace',
      showInputBox: async () => 'missing',
      showInformationMessage: async (message) => {
        infoMessage = message;
      },
      showQuickPick: async () => {
        quickPickShown = true;
        return undefined;
      },
    });

    await command();

    assert.strictEqual(infoMessage, 'No notes found with tag "missing".');
    assert.strictEqual(quickPickShown, false);
  });

  test('uses a clicked hover tag without prompting again', async () => {
    let prompted = false;
    let searchedTag = '';
    const command = createSearchByTagCommand({
      cliClient: {
        searchNotes: async (input) => {
          searchedTag = input.tag ?? '';
          return [];
        },
      } as Pick<CliClient, 'searchNotes'>,
      getWorkspaceRoot: () => '/workspace',
      showInputBox: async () => {
        prompted = true;
        return 'other';
      },
      showInformationMessage: async () => undefined,
    });

    await command('parser_[x]');

    assert.strictEqual(prompted, false);
    assert.strictEqual(searchedTag, 'parser_[x]');
  });

  test('uses a bounded content preview in result labels', () => {
    const note = createLineNote('x'.repeat(100));
    const [item] = buildTagSearchQuickPickItems([note]);

    assert.ok((item?.label.length ?? 0) <= 61);
    assert.ok(item?.label.endsWith('…'));
    assert.notStrictEqual(item?.label, note.note.content);
  });

  test('registers the tag search command in the extension manifest', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      activationEvents?: string[];
      contributes?: {
        commands?: Array<{ command: string; title: string }>;
        menus?: { commandPalette?: Array<{ command: string }> };
      };
    };

    const command = packageJson.contributes?.commands?.find(
      (entry) => entry.command === COMMAND_IDS.searchNotesByTag,
    );
    const palette = packageJson.contributes?.menus?.commandPalette ?? [];

    assert.strictEqual(command?.title, 'Search Notes by Tag');
    assert.ok(palette.some((entry) => entry.command === COMMAND_IDS.searchNotesByTag));
    assert.ok(
      packageJson.activationEvents?.includes(`onCommand:${COMMAND_IDS.searchNotesByTag}`),
    );
  });
});

function createLineNote(content = 'Finish parser cleanup'): NoteView {
  return {
    source_file: 'src/main.rs',
    note: {
      id: 'line-note',
      anchor: { type: 'Line', line: 3, column: 2 },
      content,
      tags: ['todo', 'urgent'],
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    },
  };
}

function createSymbolNote(): NoteView {
  return {
    source_file: 'src/lib.rs',
    note: {
      id: 'symbol-note',
      anchor: {
        type: 'Symbol',
        name: 'parse',
        kind: 'Function',
        line_hint: 9,
      },
      content: 'Document parser behavior',
      tags: ['todo'],
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    },
    resolved: { line: 12, column: 1 },
  };
}
