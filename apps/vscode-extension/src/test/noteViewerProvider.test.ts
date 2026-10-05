import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { suite, test, teardown } from 'mocha';
import * as vscode from 'vscode';

import { COMMAND_IDS } from '../constants/ids';
import { NoteViewerController } from '../features/note-viewer/noteViewerController';
import { buildExpandedPreviewDecorations } from '../features/note-viewer/noteViewerRenderer';
import { buildNoteViewerItems } from '../features/note-viewer/noteViewerModel';
import type { CurrentFileNotesSnapshot } from '../features/current-file/store';
import type { NoteView } from '../types';

const workspaces: string[] = [];

suite('Note viewer CodeLens provider', () => {
  teardown(async () => {
    await vscode.workspace
      .getConfiguration('frilvault')
      .update('noteViewer.enabled', true, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('frilvault')
      .update('noteViewer.defaultState', 'expanded', vscode.ConfigurationTarget.Global);

    while (workspaces.length > 0) {
      const workspace = workspaces.pop();
      if (workspace) {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
  });

  test('renders a compact preview for multiline notes, toggles, refreshes, and clears safely', async function () {
    this.timeout(10_000);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frilvault-note-viewer-test-'));
    workspaces.push(root);
    const sourcePath = path.join(root, 'sample.ts');
    const otherPath = path.join(root, 'other.ts');
    const originalSource = 'const sample = 1;\nfunction parse() { return true; }\n';
    fs.writeFileSync(sourcePath, originalSource);
    fs.writeFileSync(otherPath, 'const other = true;\n');

    const source = await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath)),
    );
    const other = await vscode.workspace.openTextDocument(vscode.Uri.file(otherPath));

    let activeUri = source.document.uri.toString();
    const notesByUri = new Map<string, NoteView[]>([
      [source.document.uri.toString(), [
        lineNote('line-note', 'sample.ts', 1, 'first line\nsecond line\nthird line'),
        lineNote('line-note-2', 'sample.ts', 1, 'second note'),
        {
          source_file: 'sample.ts',
          note: {
            id: 'symbol-note',
            content: 'symbol detail',
            anchor: { type: 'Symbol', name: 'parse', kind: 'Function', line_hint: 2 },
          },
          resolved: { line: 2, column: 1 },
        },
      ]],
      [other.uri.toString(), []],
    ]);
    const fakeStore = {
      getSnapshot: (): CurrentFileNotesSnapshot => ({
        workspaceRoot: root,
        sourceFile: activeUri === source.document.uri.toString() ? 'sample.ts' : 'other.ts',
        editorDocumentUri: activeUri,
        notes: notesByUri.get(activeUri) ?? [],
        error: undefined,
        loading: false,
      }),
      notesForDocument: (document: vscode.TextDocument) => notesByUri.get(document.uri.toString()) ?? [],
    } as unknown as import('../features/current-file/store').CurrentFileNotesStore;

    const controller = new NoteViewerController(fakeStore, () => true);
    const context = { subscriptions: [] as vscode.Disposable[] } as vscode.ExtensionContext;
    controller.register(context);
    controller.register(context);

    try {
      const expanded = await getViewerLenses(source.document.uri);
      const toggle = expanded.find((lens) => lens.command?.command === COMMAND_IDS.noteViewerToggle);
      const addOrEdit = expanded.find((lens) => lens.command?.command === COMMAND_IDS.noteViewerAddOrEdit);
      const deleteLens = expanded.find((lens) => lens.command?.command === COMMAND_IDS.noteViewerDelete);

      assert.ok(toggle);
      assert.ok(addOrEdit);
      assert.ok(deleteLens);
      assert.strictEqual(toggle.command?.title, '▼');
      assert.ok(!expanded.some((lens) => lens.command?.title === 'Note Edit'));
      assert.deepStrictEqual(toggle.command?.arguments?.[0], ['line-note', 'line-note-2']);
      assert.deepStrictEqual(deleteLens.command?.arguments?.[0], ['line-note', 'line-note-2']);
      assert.strictEqual(addOrEdit.command?.title, '+');
      assert.strictEqual(toggle.command?.title, '▼');
      assert.strictEqual(deleteLens.command?.title, '−');
      assert.ok(!expanded.some((lens) => lens.command?.command === COMMAND_IDS.noteViewerActions));
      assert.ok(!expanded.some((lens) => lens.command?.title?.startsWith('#')));
      assert.ok(expanded.some((lens) => lens.command?.arguments?.[0]?.includes?.('symbol-note')));

      const expandedItems = buildNoteViewerItems(
        notesByUri.get(source.document.uri.toString()) ?? [],
        'expanded',
      );
      const previewDecorations = buildExpandedPreviewDecorations(source.document, expandedItems);
      assert.strictEqual(previewDecorations.length, 2);
      assert.strictEqual(
        previewDecorations.find((item) => item.range.start.line === 0)?.renderOptions?.after?.contentText,
        '  first line · second note',
      );

      const initialViewerLensCount = expanded.filter(isViewerLens).length;
      controller.toggleNotes(['line-note', 'line-note-2'], source.document.uri.toString());
      const collapsed = await getViewerLenses(source.document.uri);
      const preview = collapsed.find((lens) => lens.command?.command === COMMAND_IDS.noteViewerToggle);
      assert.strictEqual(preview?.command?.title, '▶');
      assert.deepStrictEqual(
        buildExpandedPreviewDecorations(source.document, buildNoteViewerItems(
          notesByUri.get(source.document.uri.toString()) ?? [],
          'expanded',
        ).map((item) => ({ ...item, collapsed: item.noteId !== 'symbol-note' }))),
        buildExpandedPreviewDecorations(source.document, expandedItems.filter((item) => item.noteId === 'symbol-note')),
      );
      assert.strictEqual(collapsed.filter(isViewerLens).length, initialViewerLensCount);
      assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), originalSource);

      activeUri = other.uri.toString();
      await vscode.window.showTextDocument(other);
      assert.strictEqual(
        (await getViewerLenses(source.document.uri)).filter(isViewerLens).length,
        0,
      );
      assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), originalSource);

      activeUri = source.document.uri.toString();
      notesByUri.set(source.document.uri.toString(), [
        lineNote('edited-note', 'sample.ts', 1, 'edited content'),
      ]);
      await vscode.window.showTextDocument(source.document);
      controller.refresh();
      const refreshed = await getViewerLenses(source.document.uri);
      assert.ok(refreshed.some((lens) => lens.command?.title === '▼'));
      assert.ok(!refreshed.some((lens) => lens.command?.arguments?.[0]?.includes?.('line-note')));

      notesByUri.set(source.document.uri.toString(), []);
      controller.refresh();
      const emptyLenses = await getViewerLenses(source.document.uri);
      assert.ok(emptyLenses.some((lens) => lens.command?.command === COMMAND_IDS.noteViewerAddOrEdit));
      assert.ok(!emptyLenses.some((lens) => [
        COMMAND_IDS.noteViewerToggle,
        COMMAND_IDS.noteViewerDelete,
      ].includes(lens.command?.command as typeof COMMAND_IDS.noteViewerToggle | typeof COMMAND_IDS.noteViewerDelete)));

      await vscode.workspace
        .getConfiguration('frilvault')
        .update('noteViewer.enabled', false, vscode.ConfigurationTarget.Global);
      assert.strictEqual(
        (await getViewerLenses(source.document.uri)).filter(isViewerLens).length,
        0,
      );
    } finally {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
      controller.dispose();
    }
  });
});

async function getViewerLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return lenses ?? [];
}

function isViewerLens(lens: vscode.CodeLens): boolean {
  return [
    COMMAND_IDS.noteViewerToggle,
    COMMAND_IDS.noteViewerAddOrEdit,
    COMMAND_IDS.noteViewerDelete,
  ].includes(lens.command?.command as
    | typeof COMMAND_IDS.noteViewerToggle
    | typeof COMMAND_IDS.noteViewerAddOrEdit
    | typeof COMMAND_IDS.noteViewerDelete);
}

function lineNote(id: string, sourceFile: string, line: number, content: string): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id,
      content,
      anchor: { type: 'Line', line, column: 1 },
    },
  };
}
