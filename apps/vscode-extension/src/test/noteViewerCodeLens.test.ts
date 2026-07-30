import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { registerNoteViewerCodeLensProvider } from '../features/note-viewer/codelens';
import { NoteViewerState } from '../features/note-viewer/state';
import type { NoteView } from '../types';

suite('Note viewer CodeLens provider', () => {
  test('provides expand and collapse lenses for grouped notes', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frilvault-codelens-'));
    const sourcePath = path.join(workspaceRoot, 'src');
    const filePath = path.join(sourcePath, 'sample.ts');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(filePath, 'const sample = 1;\nconst next = 2;\n');

    let capturedProvider: vscode.CodeLensProvider | undefined;
    const original = vscode.languages.registerCodeLensProvider;
    vscode.languages.registerCodeLensProvider = ((_selector, provider) => {
      capturedProvider = provider;
      return { dispose: () => undefined };
    }) as typeof vscode.languages.registerCodeLensProvider;

    try {
      const state = new NoteViewerState();
      registerNoteViewerCodeLensProvider(
        { subscriptions: [] as vscode.Disposable[] } as vscode.ExtensionContext,
        {
          getSnapshot: () => ({
            workspaceRoot,
            sourceFile: path.join('src', 'sample.ts'),
            editorDocumentUri: vscode.Uri.file(filePath).toString(),
            notes: [
              createLineNoteView('note-1', 'first', path.join('src', 'sample.ts'), 1),
              createLineNoteView('note-2', 'second', path.join('src', 'sample.ts'), 1),
            ],
            error: undefined,
            loading: false,
          }),
        } as unknown as import('../features/current-file/store').CurrentFileNotesStore,
        () => workspaceRoot,
        () => true,
        state,
        new vscode.EventEmitter<void>().event,
      );

      const document = await vscode.workspace.openTextDocument(filePath);
      const provider = capturedProvider;

      assert.ok(provider);

      const collapsed = (await provider.provideCodeLenses?.(document, new vscode.CancellationTokenSource().token)) ?? [];
      assert.strictEqual(collapsed[0]?.command?.title, 'Expand Note');

      state.toggle(document.uri.toString(), '0:note-1,note-2', 'collapsed');

      const expanded = (await provider.provideCodeLenses?.(document, new vscode.CancellationTokenSource().token)) ?? [];
      assert.strictEqual(expanded[0]?.command?.title, 'Collapse Note');
    } finally {
      vscode.languages.registerCodeLensProvider = original;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function createLineNoteView(
  id: string,
  content: string,
  sourceFile: string,
  line: number,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id,
      content,
      anchor: { type: 'Line', line, column: 1 },
      created_at: '2026-07-30T00:00:00Z',
      updated_at: '2026-07-30T00:00:00Z',
    },
  };
}
