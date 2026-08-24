import * as vscode from 'vscode';

import { COMMAND_IDS, VIEW_ITEM_CONTEXT } from '../../constants/ids';
import type { NoteView, TagSummary } from '../../types';
import { formatNoteHover } from '../../utils/noteMarkdown';
import { tagNoteDescription, tagNotePreview } from './presentation';

export class TagExplorerStatusItem extends vscode.TreeItem {
  public constructor(message: string, icon: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class TagExplorerTagItem extends vscode.TreeItem {
  public constructor(public readonly summary: TagSummary) {
    super(summary.tag, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `(${summary.note_count})`;
    this.iconPath = new vscode.ThemeIcon('tag');
    this.contextValue = VIEW_ITEM_CONTEXT.tag;
  }
}

export class TagExplorerNoteItem extends vscode.TreeItem {
  public constructor(
    public readonly noteView: NoteView,
    workspaceRoot: string,
  ) {
    super(tagNotePreview(noteView), vscode.TreeItemCollapsibleState.None);
    this.description = tagNoteDescription(noteView);
    this.tooltip = formatNoteHover(noteView, workspaceRoot);
    this.iconPath = new vscode.ThemeIcon('note');
    this.contextValue = VIEW_ITEM_CONTEXT.tagNote;
    this.command = {
      command: COMMAND_IDS.notesPanelOpenNote,
      title: 'Open Note',
      arguments: [noteView],
    };
  }
}

export type TagExplorerTreeNode =
  | TagExplorerStatusItem
  | TagExplorerTagItem
  | TagExplorerNoteItem;
