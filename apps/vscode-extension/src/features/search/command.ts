import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import type { NoteView } from '../../types';
import { revealNote } from '../../utils/file';
import {
  formatNoteQuickPickDescription,
  noteQuickPickLabel,
} from '../notes-panel/presentation';

export type SearchQuickPickItem = vscode.QuickPickItem & {
  note: NoteView;
};

export interface SearchByTagCommandDependencies {
  cliClient: Pick<CliClient, 'searchNotes'>;
  getWorkspaceRoot: () => string;
  showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  showInformationMessage?: (message: string) => Thenable<unknown>;
  showQuickPick?: (
    items: SearchQuickPickItem[],
    options: vscode.QuickPickOptions,
  ) => Thenable<SearchQuickPickItem | undefined>;
  revealNote?: (note: NoteView, workspaceRoot: string) => Promise<void>;
}

export function createSearchCommand(
  cliClient: CliClient,
  getWorkspaceRoot: () => string,
): () => Promise<void> {
  return async () => {
    const keyword = await vscode.window.showInputBox({
      prompt: 'Search FrilVault notes',
      ignoreFocusOut: true,
    });

    if (!keyword || keyword.trim().length === 0) {
      return;
    }

    const workspaceRoot = getWorkspaceRoot();
    const results = await cliClient.searchNotes({
      workspaceRoot,
      keyword: keyword.trim(),
    });

    if (results.length === 0) {
      await vscode.window.showInformationMessage(`No notes found for "${keyword}".`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      results.map((note) => ({
        label: note.note.content,
        description: note.source_file,
        detail:
          note.note.anchor.type === 'Line'
            ? `Line ${note.note.anchor.line ?? 1}, Column ${note.note.anchor.column ?? 1}`
            : `${note.note.anchor.name ?? 'Symbol'} `,
        note,
      })),
      { placeHolder: `Found ${results.length} note(s)` },
    );

    if (picked) {
      await revealNote(picked.note, workspaceRoot);
    }
  };
}

export function createSearchByTagCommand(
  dependencies: SearchByTagCommandDependencies,
): () => Promise<void> {
  return async () => {
    const showInputBox = dependencies.showInputBox ?? vscode.window.showInputBox;
    const tag = await showInputBox({
      prompt: 'Search FrilVault notes by tag',
      placeHolder: 'todo or #todo',
      ignoreFocusOut: true,
    });

    if (!tag || tag.trim().length === 0) {
      return;
    }

    const normalizedInput = tag.trim();
    const workspaceRoot = dependencies.getWorkspaceRoot();
    const results = await dependencies.cliClient.searchNotes({
      workspaceRoot,
      tag: normalizedInput,
    });

    if (results.length === 0) {
      const showInformationMessage =
        dependencies.showInformationMessage ?? vscode.window.showInformationMessage;
      await showInformationMessage(`No notes found with tag "${normalizedInput}".`);
      return;
    }

    const showQuickPick = dependencies.showQuickPick ?? vscode.window.showQuickPick;
    const picked = await showQuickPick(
      buildTagSearchQuickPickItems(results),
      { placeHolder: `Found ${results.length} note(s) tagged "${normalizedInput}"` },
    );

    if (picked) {
      await (dependencies.revealNote ?? revealNote)(picked.note, workspaceRoot);
    }
  };
}

export function buildTagSearchQuickPickItems(results: NoteView[]): SearchQuickPickItem[] {
  return results.map((note) => ({
    label: noteQuickPickLabel(note),
    description: `${note.source_file} · ${formatNoteQuickPickDescription(note)}`,
    detail: `Tags: ${note.note.tags?.join(', ') ?? ''}`,
    note,
  }));
}
