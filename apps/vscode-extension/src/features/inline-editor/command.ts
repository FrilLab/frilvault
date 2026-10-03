import * as vscode from 'vscode';

import type { NoteView } from '../../types';
import type { InlineNoteEditor } from './editor';

/** Unified dispatch used by the palette, shortcut, and compatibility aliases. */
export function createAddOrEditNoteCommand(
  editor: InlineNoteEditor,
  showErrorMessage = (message: string) => vscode.window.showErrorMessage(message),
): (noteId?: string, sourceFile?: string, noteView?: NoteView) => Promise<void> {
  return async (noteId, sourceFile, noteView) => {
    try {
      if (noteView) {
        await editor.openEdit(noteView);
      } else if (noteId && sourceFile) {
        await editor.openEditById(noteId, sourceFile);
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
