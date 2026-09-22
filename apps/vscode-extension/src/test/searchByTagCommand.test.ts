import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { COMMAND_IDS } from '../constants/ids';
import type { CliClient, SearchNotesInput } from '../core/cliClient';
import {
  buildSearchQuickPickItems,
  buildTagSearchQuickPickItems,
  createSearchByTagCommand,
  createWorkspaceSearchCommand,
  getSearchHighlightLine,
  parseSearchQuery,
  type SearchQuickPickItem,
} from '../features/search/command';
import type { NoteView } from '../types';

suite('Search notes by tag command', () => {
  test('opens a native Quick Pick and searches the parsed query while typing', async () => {
    let changeValue: ((value: string) => void) | undefined;
    let accept: (() => void) | undefined;
    let hide: (() => void) | undefined;
    let searchedInput: SearchNotesInput | undefined;
    let revealed: NoteView | undefined;
    let shown = false;
    const quickPick = {
      title: '',
      placeholder: '',
      value: '',
      items: [] as SearchQuickPickItem[],
      selectedItems: [] as SearchQuickPickItem[],
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      onDidChangeValue: (listener: (value: string) => void) => {
        changeValue = listener;
        return { dispose: () => undefined };
      },
      onDidAccept: (listener: () => void) => {
        accept = listener;
        return { dispose: () => undefined };
      },
      onDidHide: (listener: () => void) => {
        hide = listener;
        return { dispose: () => undefined };
      },
      show: () => {
        shown = true;
        quickPick.value = 'tag:todo parser';
        changeValue?.(quickPick.value);
        setTimeout(() => {
          quickPick.selectedItems = quickPick.items.filter((item) => item.note).slice(0, 1);
          accept?.();
        }, 20);
      },
      hide: () => hide?.(),
      dispose: () => undefined,
    } as unknown as vscode.QuickPick<SearchQuickPickItem>;

    const command = createWorkspaceSearchCommand({
      cliClient: {
        searchNotes: async (input) => {
          searchedInput = input;
          return [createLineNote()];
        },
      } as Pick<CliClient, 'searchNotes'>,
      getWorkspaceRoot: () => '/workspace',
      createQuickPick: () => quickPick,
      debounceMs: 0,
      revealNote: async (note) => {
        revealed = note;
      },
    });

    await command();
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(shown, true);
    assert.strictEqual(searchedInput?.workspaceRoot, '/workspace');
    assert.strictEqual(searchedInput?.keyword, 'parser');
    assert.deepStrictEqual(searchedInput?.tags, ['todo']);
    assert.strictEqual(revealed?.note.id, 'line-note');
  });

  test('parses free text and extensible filters into one core search request', () => {
    assert.deepStrictEqual(
      parseSearchQuery('parser cache tag:todo file:"src/parser.rs" symbol:parse_config'),
      {
        keyword: 'parser cache',
        sourceFile: 'src/parser.rs',
        tags: ['todo'],
        symbol: 'parse_config',
      },
    );

    assert.deepStrictEqual(parseSearchQuery('file:"C:\\My Project\\src"'), {
      keyword: undefined,
      sourceFile: 'C:\\My Project\\src',
      tags: [],
      symbol: undefined,
    });
  });

  test('explains invalid search syntax without throwing', () => {
    assert.match(parseSearchQuery('tag:').error ?? '', /requires a value/);
    assert.match(parseSearchQuery('owner:me').error ?? '', /Unknown search filter/);
    assert.match(parseSearchQuery('"unterminated').error ?? '', /unterminated quote/);
  });

  test('identifies results as FrilVault notes and keeps metadata compact', () => {
    const [item] = buildSearchQuickPickItems([createLineNote('A very long note '.repeat(20))]);

    assert.match(item?.label ?? '', /^\$\(note\) /);
    assert.match(item?.description ?? '', /src\/main\.rs · Line 3/);
    assert.match(item?.label ?? '', /FrilVault note/);
    assert.ok((item?.detail?.length ?? 0) < 130);
    assert.strictEqual(item?.alwaysShow, true);
  });

  test('marks unresolved symbols and avoids highlighting a stale hint', () => {
    const unresolved = createUnresolvedSymbolNote();
    const [item] = buildSearchQuickPickItems([unresolved]);

    assert.match(item?.description ?? '', /Unresolved symbol/);
    assert.strictEqual(getSearchHighlightLine(unresolved), undefined);
    assert.strictEqual(getSearchHighlightLine(createLineNote()), 2);
    assert.strictEqual(getSearchHighlightLine(createSymbolNote()), 11);
  });

  test('cancels stale searches and refreshes the active query after note changes', async () => {
    let changeValue: ((value: string) => void) | undefined;
    let hide: (() => void) | undefined;
    let notesChanged: (() => void) | undefined;
    const searchInputs: SearchNotesInput[] = [];
    const quickPick = {
      title: '',
      placeholder: '',
      value: '',
      items: [] as SearchQuickPickItem[],
      selectedItems: [] as SearchQuickPickItem[],
      busy: false,
      matchOnDescription: false,
      matchOnDetail: false,
      onDidChangeValue: (listener: (value: string) => void) => {
        changeValue = listener;
        return { dispose: () => undefined };
      },
      onDidAccept: () => ({ dispose: () => undefined }),
      onDidHide: (listener: () => void) => {
        hide = listener;
        return { dispose: () => undefined };
      },
      show: () => undefined,
      hide: () => hide?.(),
      dispose: () => undefined,
    } as unknown as vscode.QuickPick<SearchQuickPickItem>;

    const command = createWorkspaceSearchCommand({
      cliClient: {
        searchNotes: async (input) => {
          searchInputs.push(input);
          return [];
        },
      } as Pick<CliClient, 'searchNotes'>,
      getWorkspaceRoot: () => '/workspace',
      createQuickPick: () => quickPick,
      onDidChangeNotes: (listener) => {
        notesChanged = listener;
        return { dispose: () => undefined };
      },
      debounceMs: 0,
    });

    const commandPromise = command();
    quickPick.value = 'parser';
    changeValue?.(quickPick.value);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.strictEqual(searchInputs.length, 1);
    const firstSignal = searchInputs[0]?.signal;
    quickPick.value = 'cache';
    changeValue?.(quickPick.value);
    assert.strictEqual(firstSignal?.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(searchInputs.length, 2);

    notesChanged?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(searchInputs.length, 3);
    assert.strictEqual(searchInputs[2]?.keyword, 'cache');

    hide?.();
    await commandPromise;
  });

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
      tagQuery: '#todo',
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

    assert.strictEqual(infoMessage, 'No notes found for tag query "missing".');
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

  test('passes boolean tag expressions to the shared CLI query path', async () => {
    let searchInput: SearchNotesInput | undefined;
    const command = createSearchByTagCommand({
      cliClient: {
        searchNotes: async (input) => {
          searchInput = input;
          return [];
        },
      } as Pick<CliClient, 'searchNotes'>,
      getWorkspaceRoot: () => '/workspace',
      showInputBox: async () => 'tag:bug OR tag:security NOT tag:legacy',
      showInformationMessage: async () => undefined,
    });

    await command();

    assert.deepStrictEqual(searchInput, {
      workspaceRoot: '/workspace',
      tagQuery: 'tag:bug OR tag:security NOT tag:legacy',
    });
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

function createUnresolvedSymbolNote(): NoteView {
  return {
    source_file: 'src/lib.rs',
    note: {
      id: 'unresolved-symbol-note',
      anchor: {
        type: 'Symbol',
        name: 'missing_symbol',
        kind: 'Function',
        line_hint: 27,
      },
      content: 'Document a missing symbol',
      tags: [],
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:00Z',
    },
  };
}
