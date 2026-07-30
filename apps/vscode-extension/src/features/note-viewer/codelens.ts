import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../constants/ids';
import type { CurrentFileNotesStore } from '../current-file/store';
import { getRelativePathForDocument } from '../../utils/file';
import {
  getNoteViewerDefaultState,
  isNoteViewerEnabled,
} from './config';
import { groupNotesForViewer } from './model';
import type { NoteViewerState } from './state';

export function registerNoteViewerCodeLensProvider(
  context: vscode.ExtensionContext,
  store: CurrentFileNotesStore,
  getWorkspaceRoot: () => string,
  isEnabled: () => boolean,
  state: NoteViewerState,
  onRefresh: vscode.Event<void>,
): void {
  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: onRefresh,
    provideCodeLenses(document) {
      if (!isEnabled() || !isNoteViewerEnabled()) {
        return [];
      }

      const relativePath = getRelativePathForDocument(document, getWorkspaceRoot());

      if (!relativePath) {
        return [];
      }

      const notes = store.getSnapshot().notes.filter((note) => note.source_file === relativePath);
      const groups = groupNotesForViewer(notes, document.lineCount);
      const lenses: vscode.CodeLens[] = [];
      const documentUri = document.uri.toString();
      const defaultState = getNoteViewerDefaultState();

      for (const group of groups) {
        const expanded = state.isExpanded(documentUri, group.id, defaultState);
        lenses.push(
          new vscode.CodeLens(new vscode.Range(group.line, 0, group.line, 0), {
            title: expanded ? 'Collapse Note' : 'Expand Note',
            command: COMMAND_IDS.noteViewerToggle,
            arguments: [documentUri, group.id],
          }),
        );
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.uri.toString() === documentUri) {
        const activeLine = activeEditor.selection.active.line;
        const hasNoteOnActiveLine = groups.some((group) => group.line === activeLine);

        if (!hasNoteOnActiveLine) {
          lenses.push(
            new vscode.CodeLens(new vscode.Range(activeLine, 0, activeLine, 0), {
              title: 'Note Add',
              command: COMMAND_IDS.addNote,
            }),
          );
        }
      }

      return lenses;
    },
  };

  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider));
}
