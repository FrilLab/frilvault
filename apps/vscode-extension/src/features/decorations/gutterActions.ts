import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import type { NoteView } from '../../types';
import { getRelativeFilePath, revealNote } from '../../utils/file';
import {
  buildNoteContentForClipboard,
  buildNoteMarkdownForClipboard,
} from '../presentation/noteClipboard';
import { sortNotesDeterministic } from './aggregate';
import type { GutterNoteRegistry } from './registry';

export interface GutterActionsDependencies {
  cliClient: CliClient;
  registry: GutterNoteRegistry;
  getWorkspaceRoot: () => string;
  invalidateViews: () => Promise<void>;
  openInlineEditor: (noteView: NoteView) => void;
  showErrorMessage?: (message: string) => Thenable<string | undefined>;
  showInformationMessage?: (message: string) => Thenable<string | undefined>;
  showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  showQuickPick?: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: vscode.QuickPickOptions,
  ) => Thenable<T | undefined>;
  showWarningMessage?: (
    message: string,
    options: vscode.MessageOptions,
    ...items: string[]
  ) => Thenable<string | undefined>;
}

export class GutterNoteActions {
  public constructor(private readonly dependencies: GutterActionsDependencies) {}

  public async showActions(line: number, sourceFile: string): Promise<void> {
    const notes = this.notesForLine(line, sourceFile);

    if (notes.length === 0) {
      return;
    }

    if (notes.length === 1) {
      await this.showActionMenu(notes[0], sourceFile);
      return;
    }

    const selected = await this.pickNote(notes);

    if (!selected) {
      return;
    }

    await this.showActionMenu(selected, sourceFile);
  }

  public async showActionsForNotes(noteIds: string[], sourceFile: string): Promise<void> {
    const notes = noteIds
      .map((noteId) => this.findNote(noteId, sourceFile))
      .filter((note): note is NoteView => note !== undefined);

    if (notes.length === 0) {
      await this.showError('The selected FrilVault note is no longer available.');
      return;
    }

    const selected = notes.length === 1 ? notes[0] : await this.pickNote(notes);
    if (selected) {
      await this.showActionMenu(selected, sourceFile);
    }
  }

  public async viewNote(noteId: string, sourceFile: string): Promise<void> {
    const note = this.findNote(noteId, sourceFile);

    if (!note) {
      await this.showError(`Note ${noteId} was not found on this file.`);
      return;
    }

    await revealNote(note, this.dependencies.getWorkspaceRoot());
  }

  public async editNote(noteId: string, sourceFile: string): Promise<void> {
    const note = this.findNote(noteId, sourceFile);

    if (!note) {
      await this.showError(`Note ${noteId} was not found on this file.`);
      return;
    }

    this.dependencies.openInlineEditor(note);
  }

  public async deleteNote(noteId: string, sourceFile: string): Promise<void> {
    const note = this.findNote(noteId, sourceFile);

    if (!note) {
      await this.showError(`Note ${noteId} was not found on this file.`);
      return;
    }

    const showWarningMessage =
      this.dependencies.showWarningMessage ?? vscode.window.showWarningMessage;
    const confirmed = await showWarningMessage(
      'Delete this FrilVault note?',
      { modal: true },
      'Delete',
    );

    if (confirmed !== 'Delete') {
      return;
    }

    try {
      await this.dependencies.cliClient.deleteNote(
        this.dependencies.getWorkspaceRoot(),
        sourceFile,
        noteId,
      );
      await this.dependencies.invalidateViews();
      await this.showInfo('FrilVault note deleted.');
    } catch (error) {
      await this.showError(formatError(error, 'Failed to delete note.'));
    }
  }

  public async copyLink(noteId: string, sourceFile: string): Promise<void> {
    const note = this.findNote(noteId, sourceFile);

    if (!note) {
      await this.showError(`Note ${noteId} was not found on this file.`);
      return;
    }

    const uri = buildNoteUri(noteId, this.dependencies.getWorkspaceRoot());
    await vscode.env.clipboard.writeText(uri);
    await this.showInfo('FrilVault note link copied to clipboard.');
  }

  public async copyNoteContent(noteId: string, sourceFile: string): Promise<void> {
    const note = this.findNote(noteId, sourceFile);

    if (!note) {
      await this.showError(`Note ${noteId} was not found on this file.`);
      return;
    }

    await vscode.env.clipboard.writeText(buildNoteContentForClipboard(note));
    await this.showInfo('FrilVault note content copied to clipboard.');
  }

  public async copyNoteMarkdown(noteId: string, sourceFile: string): Promise<void> {
    const note = this.findNote(noteId, sourceFile);

    if (!note) {
      await this.showError(`Note ${noteId} was not found on this file.`);
      return;
    }

    await vscode.env.clipboard.writeText(
      buildNoteMarkdownForClipboard(note, this.dependencies.getWorkspaceRoot()),
    );
    await this.showInfo('FrilVault note markdown copied to clipboard.');
  }

  private async showActionMenu(note: NoteView, sourceFile: string): Promise<void> {
    const showQuickPick = this.dependencies.showQuickPick ?? vscode.window.showQuickPick;
    const choice = await showQuickPick(
      [
        { label: 'View', action: 'view' as const },
        { label: 'Edit', action: 'edit' as const },
        { label: 'Delete', action: 'delete' as const },
        { label: 'Copy Link', action: 'copy' as const },
        { label: 'Copy Content', action: 'copyContent' as const },
        { label: 'Copy Markdown', action: 'copyMarkdown' as const },
      ],
      { title: noteKindLabel(note), placeHolder: truncateContent(note.note.content) },
    );

    if (!choice) {
      return;
    }

    switch (choice.action) {
      case 'view':
        await this.viewNote(note.note.id, sourceFile);
        break;
      case 'edit':
        await this.editNote(note.note.id, sourceFile);
        break;
      case 'delete':
        await this.deleteNote(note.note.id, sourceFile);
        break;
      case 'copy':
        await this.copyLink(note.note.id, sourceFile);
        break;
      case 'copyContent':
        await this.copyNoteContent(note.note.id, sourceFile);
        break;
      case 'copyMarkdown':
        await this.copyNoteMarkdown(note.note.id, sourceFile);
        break;
    }
  }

  private async pickNote(notes: NoteView[]): Promise<NoteView | undefined> {
    const showQuickPick = this.dependencies.showQuickPick ?? vscode.window.showQuickPick;

    return showQuickPick(
      sortNotesDeterministic(notes).map((note) => ({
        label: noteKindLabel(note),
        description: truncateContent(note.note.content),
        note,
      })),
      { title: 'Select FrilVault note', placeHolder: 'Choose a note on this line' },
    ).then((item) => item?.note);
  }

  private notesForLine(line: number, sourceFile: string): NoteView[] {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return [];
    }

    try {
      const relativePath = getRelativeFilePath(
        this.dependencies.getWorkspaceRoot(),
        editor.document.uri.fsPath,
      );

      if (relativePath !== sourceFile) {
        return [];
      }
    } catch {
      return [];
    }

    return this.dependencies.registry.get(editor.document.uri.toString(), line);
  }

  private findNote(noteId: string, sourceFile: string): NoteView | undefined {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return undefined;
    }

    return this.dependencies.registry.findNote(
      editor.document.uri.toString(),
      noteId,
      sourceFile,
    );
  }

  private async showError(message: string): Promise<void> {
    const showErrorMessage =
      this.dependencies.showErrorMessage ?? vscode.window.showErrorMessage;

    await showErrorMessage(`FrilVault: ${message}`);
  }

  private async showInfo(message: string): Promise<void> {
    const showInformationMessage =
      this.dependencies.showInformationMessage ?? vscode.window.showInformationMessage;

    await showInformationMessage(message);
  }
}

export function buildNoteUri(noteId: string, workspaceRoot: string): string {
  const encodedRoot = encodeURIComponent(workspaceRoot);
  return `frilvault://note/v1/${noteId}?workspace=${encodedRoot}`;
}

function noteKindLabel(note: NoteView): string {
  if (note.note.anchor.type === 'Symbol') {
    return note.note.anchor.name ?? 'Symbol note';
  }

  return 'Line note';
}

function truncateContent(content: string): string {
  return content.length > 60 ? `${content.slice(0, 57)}...` : content;
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
