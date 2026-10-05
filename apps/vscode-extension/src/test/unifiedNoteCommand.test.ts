import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { CliClient } from '../core/cliClient';
import { createAddOrEditNoteCommand, createEditNoteCommand } from '../features/inline-editor/command';
import { InlineNoteEditor } from '../features/inline-editor/editor';
import { DebouncedAutoSave } from '../features/inline-editor/autoSave';
import { recoveryId, InlineNoteDraftRecoveryStore } from '../features/inline-editor/draftRecovery';
import type { InlineNoteDraft } from '../features/inline-editor/draft';
import type { InlineNotePanelLike, InlineNotePanelMessage } from '../features/inline-editor/panel';
import type { NoteView } from '../types';
import { isEligibleSourceEditor } from '../features/inline-editor/sourceContext';

suite('Unified Add / Edit Note', function () {
  this.timeout(15_000);

  test('dispatches cursor and exact-note invocations through the same command and edit alias', async () => {
    const calls: unknown[] = [];
    const editor = {
      openCreateHere: async () => { calls.push('cursor'); },
      openEdit: async (note: NoteView) => { calls.push(note); },
      openEditById: async (id: string, file: string) => { calls.push([id, file]); },
    } as unknown as InlineNoteEditor;
    const command = createAddOrEditNoteCommand(editor);
    const exact = note('legacy-2', { type: 'Line', line: 1, column: 1 });
    await command();
    await command(exact.note.id, exact.source_file, exact);
    await command('legacy-1', exact.source_file);
    await createEditNoteCommand(editor)();
    assert.deepStrictEqual(calls, ['cursor', exact, ['legacy-1', exact.source_file], 'cursor']);
  });

  test('editor context URI dispatch retains the invoking file and partial note targets cannot create', async () => {
    const fixture = await sourceFixture('source');
    let invoked: vscode.TextEditor | undefined;
    let error = '';
    const command = createAddOrEditNoteCommand({
      openCreateHere: async (editor: vscode.TextEditor) => { invoked = editor; },
    } as unknown as InlineNoteEditor, async (message) => { error = message; return undefined; });
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: 'other split' }), vscode.ViewColumn.Two);
      await command(fixture.editor.document.uri);
      assert.strictEqual(invoked?.document.uri.toString(), fixture.editor.document.uri.toString());
      invoked = undefined;
      await command('partial-note-id');
      assert.strictEqual(invoked, undefined);
      assert.match(error, /ID and source file/);
    } finally { await fixture.dispose(); }
  });

  test('reports an actionable no-source error without mutation', async () => {
    let error = '';
    await createAddOrEditNoteCommand({
      openCreateHere: async () => { throw new Error('Open a source file in a workspace folder.'); },
    } as unknown as InlineNoteEditor, async (message) => { error = message; return undefined; })();
    assert.match(error, /Open a source file/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const setup = makeEditor('/tmp/workspace', []);
    try {
      await assert.rejects(setup.editor.openCreateHere(), /Open a source file/);
      assert.strictEqual(setup.opened.length, 0);
    } finally { setup.editor.dispose(); }
  });

  test('Line / Symbol choice is explicit, separate from deterministic legacy selection, and cancellable', async () => {
    const fixture = await sourceFixture('function parse() {}\n\n');
    const symbol = { type: 'Symbol' as const, name: 'parse', kind: 'Function', signature: 'function parse() {}', line_hint: 99 };
    const notes = [note('z', symbol), note('a', symbol), note('line', { type: 'Line', line: 1, column: 1 })];
    const pickerTitles: string[] = [];
    let cancel = true;
    const setup = makeEditor(fixture.root, notes, (items, options) => {
      pickerTitles.push(options?.title ?? '');
      if (cancel) { return undefined; }
      if (items[0].label.startsWith('Line ')) { return items[1]; }
      assert.deepStrictEqual(items.map((item) => item.description), ['a', 'z']);
      return items[1];
    });
    try {
      await setup.editor.openCreateHere(fixture.editor);
      assert.strictEqual(setup.opened.length, 0);
      assert.deepStrictEqual(pickerTitles, ['Add / Edit Note: choose anchor']);
      cancel = false;
      await setup.editor.openCreateHere(fixture.editor);
      assert.strictEqual(setup.opened[0].noteId, 'z');
      assert.deepStrictEqual(pickerTitles.slice(1), ['Add / Edit Note: choose anchor', 'Select legacy note to edit']);
      // A specific note control bypasses both choosers.
      await setup.editor.openEditById('a', '노트.txt');
      assert.strictEqual(setup.opened.at(-1)?.noteId, 'a');
      assert.strictEqual(pickerTitles.length, 3);
      assert.deepStrictEqual(fs.readFileSync(fixture.file), fixture.bytes);
    } finally { setup.editor.dispose(); await fixture.dispose(); }
  });

  test('explicit Line requests bypass symbols; blank first/last lines remain usable', async () => {
    const fixture = await sourceFixture('\nfunction parse() {}\n');
    const setup = makeEditor(fixture.root, [], () => { assert.fail('No anchor chooser expected'); });
    try {
      for (const line of [0, 1, 2]) {
        fixture.editor.selection = new vscode.Selection(line, 0, line, 0);
        await setup.editor.openCreateHere(fixture.editor, 'Line');
        assert.strictEqual(setup.opened.at(-1)?.kind, 'Line');
        assert.strictEqual(setup.opened.at(-1)?.line, line + 1);
      }
      const blank = makeEditor(fixture.root, [], () => { assert.fail('Blank line has only a Line anchor'); });
      try {
        await blank.editor.openCreateHere(fixture.editor);
        assert.strictEqual(blank.opened[0].kind, 'Line');
      } finally { blank.editor.dispose(); }
      await assert.rejects(setup.editor.openCreateHere(fixture.editor, 'Symbol'), /No symbol/);
      assert.deepStrictEqual(fs.readFileSync(fixture.file), fixture.bytes);
    } finally { setup.editor.dispose(); await fixture.dispose(); }
  });

  test('the invoking split editor supplies its own cursor and survives focus changes', async () => {
    const fixture = await sourceFixture('first\nsecond\nthird');
    const second = await vscode.window.showTextDocument(fixture.editor.document, vscode.ViewColumn.Two);
    fixture.editor.selection = new vscode.Selection(0, 0, 0, 0);
    second.selection = new vscode.Selection(2, 2, 2, 2);
    const setup = makeEditor(fixture.root, []);
    try {
      const opening = setup.editor.openCreateHere(second, 'Line');
      await vscode.window.showTextDocument(fixture.editor.document, vscode.ViewColumn.One);
      await opening;
      assert.strictEqual(setup.opened[0].line, 3);
      assert.strictEqual(setup.opened[0].column, 3);
    } finally { setup.editor.dispose(); await fixture.dispose(); }
  });

  test('a pending chooser and later save retain the original workspace and Vault', async () => {
    const fixture = await sourceFixture('function parse() {}');
    let workspaceRoot = fixture.root;
    let vaultPath = path.join(fixture.root, 'original-vault');
    let select: ((item: vscode.QuickPickItem) => void) | undefined;
    let choices: readonly vscode.QuickPickItem[] = [];
    const calls: { cwd: string; args: string[] }[] = [];
    const client = new CliClient({
      getConfiguredCliPath: () => '/test/flvt',
      getConfiguredVaultPath: () => vaultPath,
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (_file, args, options) => {
        calls.push({ cwd: options.cwd, args });
        if (args[0] === '--version') { return { stdout: 'flvt 0.1.0', stderr: '' }; }
        if (args.includes('add')) {
          return { stdout: JSON.stringify(note('saved', { type: 'Line', line: 1, column: 1 })), stderr: '' };
        }
        return { stdout: '[]', stderr: '' };
      },
    });
    const setup = makeEditor(fixture.root, [], async (items) => {
      choices = items;
      return new Promise<vscode.QuickPickItem>((resolve) => { select = resolve; });
    }, client, () => workspaceRoot, async () => vaultPath);
    try {
      const opening = setup.editor.openCreateHere(fixture.editor);
      await waitFor(() => Boolean(select));
      workspaceRoot = path.join(fixture.root, 'other-workspace');
      vaultPath = path.join(fixture.root, 'other-vault');
      select!(choices[0]);
      await opening;
      await setup.emit({ type: 'change', content: 'captured target', tagsText: '' });
      await setup.emit({ type: 'close' });
      const mutation = calls.find((call) => call.args.includes('add'));
      assert.ok(mutation);
      assert.strictEqual(mutation.cwd, fixture.root);
      assert.deepStrictEqual(mutation.args.slice(0, 2), ['--vault', path.join(fixture.root, 'original-vault')]);
      assert.strictEqual(setup.opened[0].sourceFile, '노트.txt');
      assert.deepStrictEqual(fs.readFileSync(fixture.file), fixture.bytes);
    } finally { setup.editor.dispose(); await fixture.dispose(); }
  });

  test('repeating an action keeps the current unsaved input and saves it once', async () => {
    const contents: string[] = [];
    const client = {
      listNotes: async () => [], tagList: async () => [],
      addLineNote: async (input: { content: string }) => {
        contents.push(input.content);
        return note('saved', { type: 'Line', line: 1, column: 1 });
      },
    } as unknown as CliClient;
    const setup = makeEditor('/tmp/workspace', [], undefined, client);
    try {
      await setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 1, column: 1 });
      await setup.emit({ type: 'change', content: 'last characters', tagsText: '' });
      await setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 1, column: 1 });
      assert.strictEqual(setup.opened.length, 1);
      await setup.emit({ type: 'close' });
      assert.deepStrictEqual(contents, ['last characters']);
    } finally { setup.editor.dispose(); }
  });

  test('legacy chooser cancellation preserves every note; unresolved symbols do not match a Line', async () => {
    const entries = [note('z', { type: 'Line', line: 1, column: 1 }), note('a', { type: 'Line', line: 1, column: 1 }),
      note('unresolved', { type: 'Symbol', name: 'missing', kind: 'Function', line_hint: 1 })];
    const setup = makeEditor('/tmp/workspace', entries, () => undefined);
    try {
      await setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 1, column: 1 });
      assert.strictEqual(setup.opened.length, 0);
      assert.strictEqual(entries.length, 3);
      await setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 2, column: 1 });
      assert.strictEqual(setup.opened[0].mode, 'create');
    } finally { setup.editor.dispose(); }
  });

  test('suspend/dispose rejects a late target; missing Vault errors do not open drafts', async () => {
    for (const action of ['suspend', 'dispose'] as const) {
      let finish: ((path: string) => void) | undefined;
      const client = { listNotes: async () => [], tagList: async () => [], withVaultPath: () => client } as unknown as CliClient;
      const setup = makeEditor('/tmp/workspace', [], undefined, client, undefined,
        () => new Promise<string>((resolve) => { finish = resolve; }));
      const opening = setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 1, column: 1 });
      setup.editor[action]();
      if (action === 'suspend') { setup.editor.resume(); }
      finish!('/tmp/selected-vault');
      await opening;
      assert.strictEqual(setup.opened.length, 0);
      setup.editor.dispose();
    }
    const setup = makeEditor('/tmp/workspace', [], undefined, undefined, undefined,
      async () => { throw new Error('No Vault found. Run flvt init explicitly.'); });
    try {
      await assert.rejects(setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 1, column: 1 }), /flvt init/);
      assert.strictEqual(setup.opened.length, 0);
    } finally { setup.editor.dispose(); }
  });

  test('recovery identity separates Vaults and symbol signatures, and retains legacy recovery', async () => {
    const setup = makeEditor('/tmp/workspace', []);
    try {
      await setup.editor.openCreateOrEditAt('노트.txt', { type: 'Symbol', name: 'parse', kind: 'Function', signature: 'function parse()' });
      const draft = setup.opened[0];
      assert.notStrictEqual(recoveryId({ ...draft, vaultPath: '/vault/a' }), recoveryId({ ...draft, vaultPath: '/vault/b' }));
      assert.notStrictEqual(recoveryId(draft), recoveryId({ ...draft, symbolSignature: 'function parse(input)' }));
      const legacyId = JSON.stringify([draft.workspaceRoot, draft.sourceFile, 'create', draft.kind, draft.line, draft.column, draft.symbolName, draft.symbolKind]);
      const recovered = { id: legacyId, sessionId: 'old', revision: 1, draft };
      const store = new InlineNoteDraftRecoveryStore({ get: () => ({ [legacyId]: recovered }) } as unknown as vscode.Memento);
      assert.deepStrictEqual(store.get({ ...draft, vaultPath: '/vault/a' }), recovered);
    } finally { setup.editor.dispose(); }
  });

  test('reopening a newly persisted note finds later recovery revisions under its original create key', async () => {
    const setup = makeEditor('/tmp/workspace', []);
    try {
      await setup.editor.openCreateOrEditAt('노트.txt', { type: 'Line', line: 1, column: 1 });
      const created = { ...setup.opened[0], vaultPath: '/vault/original' };
      const afterFirstSave: InlineNoteDraft = {
        ...created, mode: 'edit', noteId: 'saved-id', expectedUpdatedAt: 'saved-revision', content: 'latest received characters',
      };
      let state: unknown;
      const store = new InlineNoteDraftRecoveryStore({
        get: () => state,
        update: async (_key: string, value: unknown) => { state = value; },
      } as unknown as vscode.Memento);
      const originalKey = recoveryId(created);
      await store.write(originalKey, 'create-session', 2, afterFirstSave);
      assert.strictEqual(store.get(afterFirstSave)?.draft.content, 'latest received characters');
      assert.strictEqual(store.get(afterFirstSave)?.id, originalKey);
      assert.strictEqual(store.get({ ...afterFirstSave, vaultPath: '/vault/other' }), undefined);
      await store.clear(originalKey, 'create-session', 2);
      assert.strictEqual(store.get(afterFirstSave), undefined);

      const legacyKey = JSON.stringify([created.workspaceRoot, created.sourceFile, 'create', 'Line', 1, 1, null, null]);
      await store.write(legacyKey, 'legacy-session', 2, { ...afterFirstSave, vaultPath: undefined });
      assert.strictEqual(store.get(afterFirstSave)?.draft.content, 'latest received characters');
    } finally { setup.editor.dispose(); }
  });

  test('shortcut is discoverable, remappable and limited to trusted eligible source editor focus', () => {
    const manifest = vscode.extensions.getExtension('frillab.frilvault')!.packageJSON;
    const bindings = manifest.contributes.keybindings as { command: string; key: string; mac: string; when: string }[];
    const binding = bindings.find((entry) => entry.command === 'frilvault.addOrEditNote');
    assert.ok(binding);
    assert.strictEqual(binding.key, 'ctrl+k ctrl+n');
    assert.strictEqual(binding.mac, 'cmd+k cmd+n');
    for (const clause of ['editorTextFocus', 'resourceScheme == file', 'frilvault.sourceEditorEligible', 'isWorkspaceTrusted']) {
      assert.ok(binding.when.includes(clause));
    }
    assert.strictEqual(isEligibleSourceEditor(undefined, () => true), false);
    const webviewDocument = { document: { uri: vscode.Uri.parse('vscode-webview://notes') } } as vscode.TextEditor;
    assert.strictEqual(isEligibleSourceEditor(webviewDocument, () => true), false);
    assert.ok(manifest.contributes.commands.some((entry: { command: string; title: string }) =>
      entry.command === 'frilvault.addOrEditNote' && entry.title === 'Add / Edit Note'));
  });
});

function makeEditor(
  root: string,
  notes: NoteView[],
  choose?: (items: readonly vscode.QuickPickItem[], options?: vscode.QuickPickOptions) => vscode.QuickPickItem | undefined | Promise<vscode.QuickPickItem | undefined>,
  client?: CliClient,
  getRoot = () => root,
  resolveVaultPath?: (root: string) => Promise<string>,
) {
  const opened: InlineNoteDraft[] = [];
  let handler: ((message: InlineNotePanelMessage) => void | Promise<void>) | undefined;
  const panel: InlineNotePanelLike = {
    open: (_context, draft, onMessage) => { opened.push(draft); handler = onMessage; },
    updateDraft: () => undefined, close: () => undefined, isOpen: () => opened.length > 0,
  };
  const editor = new InlineNoteEditor({
    cliClient: client ?? { listNotes: async () => notes, tagList: async () => [] } as unknown as CliClient,
    getWorkspaceRoot: getRoot,
    resolveVaultPath,
    refreshNoteState: async () => undefined,
    createAutoSave: (onStatus, persist) => new DebouncedAutoSave(60_000, onStatus, persist),
    panel,
    showQuickPick: choose ? async <T extends vscode.QuickPickItem>(items: readonly T[], options?: vscode.QuickPickOptions) =>
      await choose(items, options) as T | undefined : undefined,
  });
  editor.register({ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined } } as unknown as vscode.ExtensionContext);
  return { editor, opened, emit: async (message: InlineNotePanelMessage) => { await handler?.(message); } };
}

function note(id: string, anchor: NoteView['note']['anchor']): NoteView {
  return { source_file: '노트.txt', note: { id, content: `note ${id}`, anchor } };
}

async function sourceFixture(content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frilvault-unified-'));
  const file = path.join(root, '노트.txt');
  fs.writeFileSync(file, content);
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const provider = vscode.languages.registerDocumentSymbolProvider({ pattern: file }, {
    provideDocumentSymbols: () => {
      const declaration = content.split('\n').findIndex((line) => line.startsWith('function parse'));
      return declaration < 0 ? [] : [new vscode.DocumentSymbol('parse', '', vscode.SymbolKind.Function,
        new vscode.Range(declaration, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length),
        new vscode.Range(declaration, 9, declaration, 14))];
    },
  });
  return { root, file, editor, bytes: fs.readFileSync(file), dispose: async () => {
    provider.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.ok(check());
}
