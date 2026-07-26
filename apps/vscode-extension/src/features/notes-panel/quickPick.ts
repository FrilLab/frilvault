import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import type { CurrentFileNotesSnapshot } from '../current-file/store';
import type { NoteView } from '../../types';
import { revealNote } from '../../utils/file';
import { buildNoteUri } from '../decorations/gutterActions';
import {
  formatNoteQuickPickDescription,
  formatNoteQuickPickDetail,
  groupNotesByAnchor,
  noteQuickPickLabel,
} from './presentation';

export type NoteQuickPickItem = vscode.QuickPickItem & {
  note?: NoteView;
};

export interface CurrentFileNotesQuickPickDependencies {
  cliClient: CliClient;
  getWorkspaceRoot: () => string;
  invalidateViews: () => Promise<void>;
  openInlineEditor: (noteView: NoteView) => void;
  createQuickPick?: () => vscode.QuickPick<NoteQuickPickItem>;
  showErrorMessage?: (message: string) => Thenable<string | undefined>;
  showInformationMessage?: (message: string) => Thenable<string | undefined>;
  showWarningMessage?: (
    message: string,
    options: vscode.MessageOptions,
    ...items: string[]
  ) => Thenable<string | undefined>;
}

export async function showCurrentFileNotesQuickPick(
  snapshot: CurrentFileNotesSnapshot,
  dependencies: CurrentFileNotesQuickPickDependencies,
): Promise<void> {
  const sourceFile = snapshot.sourceFile;

  if (!sourceFile) {
    return;
  }

  const workspaceRoot = dependencies.getWorkspaceRoot();
  const items = buildQuickPickItems(snapshot.notes, sourceFile);
  const quickPick = (dependencies.createQuickPick ?? vscode.window.createQuickPick<NoteQuickPickItem>)();

  quickPick.title = `Notes — ${sourceFile}`;
  quickPick.placeholder = 'Select a note to reveal its source location';
  quickPick.items = items;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];

      if (picked?.note) {
        await revealNote(picked.note, workspaceRoot);
      }

      quickPick.hide();
    });

    quickPick.onDidTriggerItemButton(async (event) => {
      const note = event.item.note;

      if (!note) {
        return;
      }

      switch (event.button.tooltip) {
        case 'Edit Note':
          dependencies.openInlineEditor(note);
          quickPick.hide();
          break;
        case 'Delete Note':
          await deleteNote(note, sourceFile, dependencies);
          quickPick.hide();
          break;
        case 'Copy Note Link':
          await copyNoteLink(note, dependencies);
          quickPick.hide();
          break;
      }
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      finish();
    });

    quickPick.show();
  });
}

export function buildQuickPickItems(notes: NoteView[], sourceFile: string): NoteQuickPickItem[] {
  const groups = groupNotesByAnchor(notes);
  const items: NoteQuickPickItem[] = [];

  for (const group of groups.symbolGroups) {
    items.push({
      label: `Symbol: ${group.name}`,
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const note of group.notes) {
      items.push(createNoteItem(note));
    }
  }

  if (groups.lineNotes.length > 0) {
    items.push({
      label: 'Line Notes',
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const note of groups.lineNotes) {
      items.push(createNoteItem(note));
    }
  }

  if (groups.unresolvedNotes.length > 0) {
    items.push({
      label: 'Unresolved Anchors',
      kind: vscode.QuickPickItemKind.Separator,
    });

    for (const note of groups.unresolvedNotes) {
      items.push(createNoteItem(note));
    }
  }

  if (items.length === 0) {
    items.push({
      label: `No notes are attached to ${sourceFile}.`,
    });
  }

  return items;
}

function createNoteItem(note: NoteView): NoteQuickPickItem {
  return {
    label: noteQuickPickLabel(note),
    description: formatNoteQuickPickDescription(note),
    detail: formatNoteQuickPickDetail(note),
    note,
    buttons: [
      { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit Note' },
      { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete Note' },
      { iconPath: new vscode.ThemeIcon('link'), tooltip: 'Copy Note Link' },
    ],
  };
}

async function deleteNote(
  noteView: NoteView,
  sourceFile: string,
  dependencies: CurrentFileNotesQuickPickDependencies,
): Promise<void> {
  const showWarningMessage =
    dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
  const confirmed = await showWarningMessage(
    'Delete this FrilVault note?',
    { modal: true },
    'Delete',
  );

  if (confirmed !== 'Delete') {
    return;
  }

  try {
    await dependencies.cliClient.deleteNote(
      dependencies.getWorkspaceRoot(),
      sourceFile,
      noteView.note.id,
    );
    await dependencies.invalidateViews();
    await showInfo(dependencies, 'FrilVault note deleted.');
  } catch (error) {
    await showError(dependencies, formatError(error, 'Failed to delete note.'));
  }
}

async function copyNoteLink(
  noteView: NoteView,
  dependencies: CurrentFileNotesQuickPickDependencies,
): Promise<void> {
  const uri = buildNoteUri(noteView.note.id, dependencies.getWorkspaceRoot());
  await vscode.env.clipboard.writeText(uri);
  await showInfo(dependencies, 'FrilVault note link copied to clipboard.');
}

async function showError(
  dependencies: CurrentFileNotesQuickPickDependencies,
  message: string,
): Promise<void> {
  const showErrorMessage =
    dependencies.showErrorMessage ?? vscode.window.showErrorMessage;

  await showErrorMessage(`FrilVault: ${message}`);
}

async function showInfo(
  dependencies: CurrentFileNotesQuickPickDependencies,
  message: string,
): Promise<void> {
  const showInformationMessage =
    dependencies.showInformationMessage ?? vscode.window.showInformationMessage;

  await showInformationMessage(message);
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
