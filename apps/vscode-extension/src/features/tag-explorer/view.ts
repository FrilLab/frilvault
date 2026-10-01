import * as vscode from 'vscode';
import * as path from 'node:path';

import { COMMAND_IDS, VIEW_ITEM_CONTEXT } from '../../constants/ids';
import type { NoteView, TagSummary } from '../../types';
import { tagFileIdentities, tagNoteLabel } from './presentation';
import { formatTag } from '../presentation/tagPresentation';
import { tagThemeColor } from '../presentation/tagColor';

export class TagExplorerStatusItem extends vscode.TreeItem {
  public constructor(message: string, icon: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

export class TagExplorerTagItem extends vscode.TreeItem {
  public constructor(
    public readonly summary: TagSummary,
    public readonly contextKey?: string,
  ) {
    super(formatTag(summary.tag), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `tag:${contextKey ?? ''}:${summary.tag.trim().toLocaleLowerCase()}`;
    this.description = `(${summary.note_count})`;
    this.iconPath = new vscode.ThemeIcon('tag', tagThemeColor(summary.color));
    this.contextValue = VIEW_ITEM_CONTEXT.tag;
  }
}

export class TagExplorerNoteItem extends vscode.TreeItem {
  public constructor(
    public readonly noteView: NoteView,
    tag: string,
    fileIdentity: string,
  ) {
    super(tagNoteLabel(noteView, fileIdentity, tag), vscode.TreeItemCollapsibleState.None);
    this.id = `tag-note:${tag.trim().toLocaleLowerCase()}:${noteView.source_file}:${noteView.note.id}`;
    const tooltip = new vscode.MarkdownString(undefined, false);
    tooltip.isTrusted = false;
    tooltip.supportHtml = false;
    tooltip.appendMarkdown(`**${escapeMarkdown(noteView.source_file)}**\n\n`);
    tooltip.appendMarkdown(`${escapeMarkdown(formatAnchor(noteView))}\n\n`);
    if (noteView.note.title?.trim()) {
      tooltip.appendMarkdown(`**${escapeMarkdown(noteView.note.title.trim())}**\n\n`);
    }
    tooltip.appendMarkdown(noteView.note.content);
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon('note');
    this.contextValue = VIEW_ITEM_CONTEXT.tagNote;
    this.command = {
      command: COMMAND_IDS.notesPanelOpenNote,
      title: 'Open Note',
      arguments: [noteView],
    };
  }
}

export function createTagNoteItems(notes: NoteView[], tag: string): TagExplorerNoteItem[] {
  const identities = tagFileIdentities(notes);
  return notes.map((note) => new TagExplorerNoteItem(
    note,
    tag,
    identities.get(normalizeSourcePath(note.source_file)) ?? note.source_file,
  ));
}

function formatAnchor(noteView: NoteView): string {
  const anchor = noteView.note.anchor;
  if (anchor.type === 'Line') {
    return `Line ${anchor.line ?? 1}:${anchor.column ?? 1}`;
  }

  const name = anchor.name ?? 'Unknown symbol';
  if (!noteView.resolved) {
    return `Symbol ${name} · unresolved. Edit this note to repair its anchor.`;
  }
  return `Symbol ${name} · Line ${noteView.resolved.line}:${noteView.resolved.column}`;
}

function normalizeSourcePath(sourceFile: string): string {
  return path.posix.normalize(sourceFile.replaceAll('\\', '/')).replace(/^\.\//, '');
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

export type TagExplorerTreeNode =
  | TagExplorerStatusItem
  | TagExplorerTagItem
  | TagExplorerNoteItem;
