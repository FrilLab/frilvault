import * as vscode from 'vscode';

import type { NoteView } from '../../types';
import type { InlineNoteEditor } from './editor';

/** Unified dispatch used by the palette, shortcut, and compatibility aliases. */
export function createAddOrEditNoteCommand(
  editor: InlineNoteEditor,
  showErrorMessage = (message: string) => vscode.window.showErrorMessage(message),
): (noteId?: string | vscode.Uri, sourceFile?: string, noteView?: NoteView) => Promise<void> {
  return async (noteId, sourceFile, noteView) => {
    try {
      if (noteView) {
        await editor.openEdit(noteView);
      } else if (noteId instanceof vscode.Uri) {
        // Editor context menus supply their resource URI. Preserve that editor
        // when another split has focus by the time the action is selected.
        const invokingEditor = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors]
          .find((candidate) => candidate?.document.uri.toString() === noteId.toString());
        if (!invokingEditor) {
          throw new Error('Focus the source editor for this file and invoke Add / Edit Note again.');
        }
        await editor.openCreateHere(invokingEditor);
      } else if (noteId && sourceFile) {
        await editor.openEditById(noteId, sourceFile);
      } else if (noteId || sourceFile) {
        throw new Error('Select a note with its ID and source file, or invoke Add / Edit Note from a source cursor.');
      } else {
        await editor.openCreateHere();
      }
    } catch (error) {
      await showErrorMessage(error instanceof Error ? error.message : 'Could not open a note.');
    }
  };
}

export const createAddNoteCommand = createAddOrEditNoteCommand;
export const createEditNoteCommand = createAddOrEditNoteCommand;
