import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../constants/ids';
import type { CurrentFileNotesStore } from '../current-file/store';
import { getActiveEditorOrThrow } from '../../utils/file';
import {
  type CurrentFileNotesQuickPickDependencies,
  showCurrentFileNotesQuickPick,
} from './quickPick';

export interface ShowNotesForCurrentFileDependencies {
  store: CurrentFileNotesStore;
  refreshNotesPanel: () => void;
  quickPick: CurrentFileNotesQuickPickDependencies;
  getActiveEditor?: () => vscode.TextEditor;
  showErrorMessage?: (message: string) => Thenable<string | undefined>;
  showInformationMessage?: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  executeCommand?: (command: string) => Thenable<unknown>;
}

export function createShowNotesForCurrentFileCommand(
  dependencies: ShowNotesForCurrentFileDependencies,
): () => Promise<void> {
  const showErrorMessage =
    dependencies.showErrorMessage ?? vscode.window.showErrorMessage;
  const showInformationMessage =
    dependencies.showInformationMessage ?? vscode.window.showInformationMessage;
  const executeCommand = dependencies.executeCommand ?? vscode.commands.executeCommand;
  const getActiveEditor = dependencies.getActiveEditor ?? getActiveEditorOrThrow;

  return async () => {
    try {
      const editor = getActiveEditor();
      await dependencies.store.syncActiveEditor(editor);
      dependencies.refreshNotesPanel();

      const snapshot = dependencies.store.getSnapshot();

      if (snapshot.error) {
        await showErrorMessage(snapshot.error);
        return;
      }

      if (!snapshot.sourceFile) {
        await showInformationMessage('Open a workspace file to view its notes.');
        return;
      }

      if (snapshot.notes.length === 0) {
        const choice = await showInformationMessage(
          'No notes are attached to this file.',
          'Add',
        );

        if (choice === 'Add') {
          await executeCommand(COMMAND_IDS.addNote);
        }

        return;
      }

      await showCurrentFileNotesQuickPick(snapshot, dependencies.quickPick);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to show notes for the current file.';

      await showErrorMessage(message);
    }
  };
}
