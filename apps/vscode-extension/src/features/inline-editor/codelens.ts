import * as vscode from 'vscode';

import type { NoteView } from '../../types';
import type { CurrentFileNotesStore } from '../current-file/store';
import { resolveNoteLine as resolvePresentationNoteLine } from '../presentation/editorNoteView';
import { getRelativePathForDocument } from '../../utils/file';

export function registerInlineNoteCodeLensProvider(
  context: vscode.ExtensionContext,
  store: CurrentFileNotesStore,
  getWorkspaceRoot: () => string,
  isEnabled: () => boolean,
  onRefresh: vscode.Event<void>,
): void {
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: onRefresh,
    provideCodeLenses(document) {
      if (!isEnabled()) {
        return [];
      }

      const relativePath = getRelativePathForDocument(document, getWorkspaceRoot());

      if (!relativePath) {
        return [];
      }

      const notes = store.getSnapshot().notes.filter((note) => note.source_file === relativePath);
      const lenses: vscode.CodeLens[] = [];

      for (const note of notes) {
        const lineNumber = resolvePresentationNoteLine(note);

        if (lineNumber === undefined) {
          continue;
        }

        const line = lineNumber - 1;
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: 'Note Edit',
            command: 'frilvault.editNote',
            arguments: [note.note.id, note.source_file, note],
          }),
        );
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === document.uri.toString()) {
        const activeLine = activeEditor.selection.active.line;
        const hasNoteOnActiveLine = notes.some((note) => {
          const lineNumber = resolvePresentationNoteLine(note);

          return lineNumber !== undefined && lineNumber - 1 === activeLine;
        });

        if (!hasNoteOnActiveLine) {
          lenses.push(
            new vscode.CodeLens(new vscode.Range(activeLine, 0, activeLine, 0), {
              title: 'Note Add',
              command: 'frilvault.addNote',
            }),
          );
        }
      }

      return lenses;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
  );
}
