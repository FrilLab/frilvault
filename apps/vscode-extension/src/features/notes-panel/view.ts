import * as vscode from 'vscode';
import * as path from 'node:path';

import { COMMAND_IDS, VIEW_ITEM_CONTEXT } from '../../constants/ids';
import type { NoteView } from '../../types';
import { formatNoteHover } from '../../utils/noteMarkdown';
import { formatTagList, SIDEBAR_TAG_LIMIT } from '../presentation/tagPresentation';

export type AnchorGroupKind = 'Line' | 'Symbol' | 'Unresolved';

export class NotesFileHeaderItem extends vscode.TreeItem {
  public constructor(sourceFile: string) {
    super(sourceFile, vscode.TreeItemCollapsibleState.None);
    this.description = 'Active file';
    this.iconPath = new vscode.ThemeIcon('file');
    this.contextValue = VIEW_ITEM_CONTEXT.notesFileHeader;
  }
}

export class NotesStatusItem extends vscode.TreeItem {
  public constructor(message: string, icon: string, commandId?: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = VIEW_ITEM_CONTEXT.notesStatus;

    if (commandId) {
      this.command = {
        command: commandId,
        title: message,
      };
    }
  }
}

export class NotesWorkspaceOverviewItem extends vscode.TreeItem {
  public constructor() {
    super('Workspace notes', vscode.TreeItemCollapsibleState.None);
    this.description = 'No active file';
    this.iconPath = new vscode.ThemeIcon('files');
    this.contextValue = VIEW_ITEM_CONTEXT.notesStatus;
  }
}

export class NotesWorkspaceFolderItem extends vscode.TreeItem {
  public constructor(
    public readonly relativePath: string,
    public readonly noteCount: number,
    public readonly children: Array<NotesWorkspaceFolderItem | NotesWorkspaceFileItem>,
  ) {
    super(path.posix.basename(relativePath), vscode.TreeItemCollapsibleState.Expanded);
    this.description = `(${noteCount})`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = VIEW_ITEM_CONTEXT.notesStatus;
  }
}

export class NotesWorkspaceFileItem extends vscode.TreeItem {
  public constructor(
    public readonly workspaceRoot: string,
    public readonly relativePath: string,
    public readonly noteCount: number,
  ) {
    super(path.posix.basename(relativePath), vscode.TreeItemCollapsibleState.None);
    this.description = `(${noteCount})`;
    this.iconPath = new vscode.ThemeIcon('file');
    this.contextValue = VIEW_ITEM_CONTEXT.notesFileHeader;
    this.command = {
      command: 'vscode.open',
      title: 'Open file',
      arguments: [vscode.Uri.file(path.join(workspaceRoot, relativePath))],
    };
  }
}

export class NotesSymbolGroupItem extends vscode.TreeItem {
  public constructor(
    public readonly symbolName: string,
    public readonly notes: NoteView[],
  ) {
    super(`Symbol: ${symbolName}`, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${notes.length}`;
    this.iconPath = new vscode.ThemeIcon('symbol-method');
    this.contextValue = VIEW_ITEM_CONTEXT.notesSymbolGroup;
  }
}

export class NotesAnchorGroupItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: AnchorGroupKind,
    public readonly notes: NoteView[],
  ) {
    const label =
      kind === 'Line'
        ? 'Line Notes'
        : kind === 'Unresolved'
          ? 'Unresolved Anchors'
          : 'Symbol Notes';

    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${notes.length}`;
    this.iconPath = new vscode.ThemeIcon(
      kind === 'Line'
        ? 'list-unordered'
        : kind === 'Unresolved'
          ? 'warning'
          : 'symbol-method',
    );
    this.contextValue =
      kind === 'Line'
        ? VIEW_ITEM_CONTEXT.notesLineGroup
        : kind === 'Unresolved'
          ? VIEW_ITEM_CONTEXT.notesUnresolvedGroup
          : VIEW_ITEM_CONTEXT.notesSymbolGroup;
  }
}

export class NotesPanelItem extends vscode.TreeItem {
  public constructor(
    public readonly noteView: NoteView,
    public readonly workspaceRoot: string,
  ) {
    super(createPreview(noteView), vscode.TreeItemCollapsibleState.None);

    this.description = createDescription(noteView);
    this.tooltip = formatNoteHover(noteView, workspaceRoot);
    this.contextValue = VIEW_ITEM_CONTEXT.note;
    this.iconPath = new vscode.ThemeIcon('note');
    this.command = {
      command: COMMAND_IDS.notesPanelOpenNote,
      title: 'Open Note',
      arguments: [noteView],
    };
  }
}

function createPreview(noteView: NoteView): string {
  return noteView.note.content.length > 60
    ? `${noteView.note.content.slice(0, 57)}...`
    : noteView.note.content;
}

function createDescription(noteView: NoteView): string {
  let anchor: string;

  if (noteView.note.anchor.type === 'Line') {
    anchor = `L${noteView.note.anchor.line ?? 1}`;
  } else {
    const resolvedLine = noteView.resolved?.line ?? noteView.note.anchor.line_hint;
    const lineHint =
      typeof resolvedLine === 'number' ? `L${resolvedLine}` : 'Unresolved';

    anchor = `${lineHint} ${noteView.note.anchor.name ?? ''}`.trim();
  }

  const tags = formatTagList(noteView.note.tags, SIDEBAR_TAG_LIMIT);

  return tags ? `${anchor} · ${tags}` : anchor;
}
