import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../constants/ids';
import type { NoteView } from '../../types';
import { appendNoteAttachments } from '../../utils/noteMarkdown';
import { deduplicateNotesById } from './deduplicateNotes';
import {
  formatAnchorLabel,
  formatNoteTitle,
  formatResolutionWarning,
  toEditorNoteView,
  type EditorNoteView,
  type ResolvedNoteAnchor,
} from './editorNoteView';
import { truncateMarkdownContent } from '../hover/richHover';
import { formatTag, HOVER_TAG_LIMIT, presentTags } from './tagPresentation';
import { tagColorMarker } from './tagColor';
import type { TagColor } from '../../types';

export const NOTE_HOVER_COMMANDS = [
  'frilvault.gutter.showActions',
  'frilvault.gutter.viewNote',
  'frilvault.gutter.editNote',
  'frilvault.gutter.deleteNote',
  'frilvault.gutter.copyLink',
  COMMAND_IDS.gutterCopyNoteContent,
  COMMAND_IDS.gutterCopyNoteMarkdown,
  COMMAND_IDS.notesPanelOpenNote,
  COMMAND_IDS.searchNotesByTag,
] as const;

export interface HoverNotePresentation {
  noteId: string;
  title?: string;
  content: string;
  tags: string[];
  anchor: ResolvedNoteAnchor;
  updatedAt?: string;
  warning?: string;
}

export interface EditorNotesHoverParts {
  contents: vscode.MarkdownString[];
}

export function toHoverNotePresentation(view: EditorNoteView): HoverNotePresentation {
  return {
    noteId: view.noteId,
    title: formatNoteTitle(view),
    content: view.content,
    tags: view.tags,
    anchor: view.anchor,
    updatedAt: view.updatedAt,
    warning: formatResolutionWarning(view.anchor),
  };
}

export function buildEditorNotesHoverParts(
  notes: NoteView[],
  workspaceRoot: string,
  sourceFile: string,
  previewLength: number,
  colorForTag: (tag: string) => TagColor | undefined = () => undefined,
): EditorNotesHoverParts {
  const uniqueNotes = deduplicateNotesById(notes);

  if (uniqueNotes.length === 0) {
    return { contents: [] };
  }

  const contentMarkdown = createContentMarkdown();
  const actionMarkdown = createTrustedActionsMarkdown();
  const presentations = uniqueNotes.map((note) =>
    toHoverNotePresentation(toEditorNoteView(note, workspaceRoot)),
  );

  buildHoverHeader(contentMarkdown);

  if (presentations.length === 1) {
    buildSingleNoteSections(
      contentMarkdown,
      presentations[0],
      uniqueNotes[0],
      workspaceRoot,
      previewLength,
      colorForTag,
    );
    buildHoverActions(actionMarkdown, presentations[0].noteId, sourceFile);
  } else {
    buildMultipleNoteSections(contentMarkdown, presentations, previewLength, colorForTag);
    buildHoverActions(actionMarkdown, presentations[0].noteId, sourceFile, true);
  }

  return { contents: [contentMarkdown, actionMarkdown] };
}

/** Legacy combined hover string for decoration summaries. */
export function formatEditorNotesHover(
  notes: NoteView[],
  workspaceRoot: string,
  sourceFile: string,
  previewLength: number,
  colorForTag: (tag: string) => TagColor | undefined = () => undefined,
): vscode.MarkdownString {
  const parts = buildEditorNotesHoverParts(
    notes,
    workspaceRoot,
    sourceFile,
    previewLength,
    colorForTag,
  );
  const combined = createContentMarkdown();

  for (const part of parts.contents) {
    combined.appendMarkdown(part.value);
  }

  return combined;
}

export function formatEditorNoteHover(
  note: NoteView,
  workspaceRoot: string,
  sourceFile: string,
  previewLength: number,
): vscode.MarkdownString {
  return formatEditorNotesHover([note], workspaceRoot, sourceFile, previewLength);
}

function buildHoverHeader(markdown: vscode.MarkdownString): void {
  markdown.appendMarkdown('**FrilVault**\n\n');
}

function buildSingleNoteSections(
  markdown: vscode.MarkdownString,
  presentation: HoverNotePresentation,
  note: NoteView,
  workspaceRoot: string,
  previewLength: number,
  colorForTag: (tag: string) => TagColor | undefined,
): void {
  buildHoverTitle(markdown, presentation.title);
  buildHoverContent(markdown, presentation.content, previewLength);
  appendNoteAttachments(markdown, note, workspaceRoot);
  buildHoverMetadata(markdown, presentation, colorForTag);
  buildHoverWarning(markdown, presentation.warning);
}

function buildMultipleNoteSections(
  markdown: vscode.MarkdownString,
  presentations: HoverNotePresentation[],
  previewLength: number,
  colorForTag: (tag: string) => TagColor | undefined,
): void {
  markdown.appendMarkdown(`**FrilVault Notes (${presentations.length})**\n\n`);

  for (const [index, presentation] of presentations.entries()) {
    if (index > 0) {
      markdown.appendMarkdown('\n\n---\n\n');
    }

    markdown.appendMarkdown(`${index + 1}. `);
    buildHoverTitle(markdown, presentation.title, true);
    buildHoverContent(markdown, presentation.content, Math.min(previewLength, 240));
    buildHoverMetadata(markdown, presentation, colorForTag);
    buildHoverWarning(markdown, presentation.warning);
  }
}

function buildHoverTitle(
  markdown: vscode.MarkdownString,
  title: string | undefined,
  inline = false,
): void {
  if (!title) {
    return;
  }

  if (inline) {
    markdown.appendMarkdown(`**${escapeMarkdownInline(title)}**\n\n`);
    return;
  }

  markdown.appendMarkdown(`**${escapeMarkdownInline(title)}**\n\n`);
}

function buildHoverContent(
  markdown: vscode.MarkdownString,
  content: string,
  previewLength: number,
): void {
  const { preview } = truncateMarkdownContent(content, previewLength);
  markdown.appendMarkdown(`${preview}\n\n`);
}

function buildHoverMetadata(
  markdown: vscode.MarkdownString,
  presentation: HoverNotePresentation,
  colorForTag: (tag: string) => TagColor | undefined,
): void {
  markdown.appendMarkdown(`${escapeMarkdownInline(formatAnchorLabel(presentation.anchor))}\n`);

  buildHoverTags(markdown, presentation.tags, colorForTag);

  if (presentation.updatedAt) {
    markdown.appendMarkdown(`Updated: ${escapeMarkdownInline(formatUpdatedAt(presentation.updatedAt))}\n`);
  }

  markdown.appendMarkdown('\n');
}

function buildHoverTags(
  markdown: vscode.MarkdownString,
  tags: string[],
  colorForTag: (tag: string) => TagColor | undefined,
): void {
  const presented = presentTags(tags, HOVER_TAG_LIMIT);

  if (presented.tags.length === 0) {
    return;
  }

  const links = presented.tags.map((tag) => {
    const marker = tagColorMarker(colorForTag(tag));
    const label = marker ? `${marker} ${formatTag(tag)}` : formatTag(tag);
    return `[${escapeMarkdownInline(label)}](${commandUri(COMMAND_IDS.searchNotesByTag, [tag])})`;
  });

  if (presented.hiddenCount > 0) {
    links.push(`+${presented.hiddenCount} more`);
  }

  markdown.appendMarkdown(`Tags: ${links.join('  ')}\n`);
}

function buildHoverWarning(markdown: vscode.MarkdownString, warning: string | undefined): void {
  if (!warning) {
    return;
  }

  markdown.appendMarkdown(`${escapeMarkdownInline(warning)}\n\n`);
}

function buildHoverActions(
  markdown: vscode.MarkdownString,
  noteId: string,
  sourceFile: string,
  multipleNotes = false,
): void {
  const links = [
    `[Open Note](${commandUri('frilvault.gutter.viewNote', [noteId, sourceFile])})`,
    `[Edit](${commandUri('frilvault.gutter.editNote', [noteId, sourceFile])})`,
    `[Delete](${commandUri('frilvault.gutter.deleteNote', [noteId, sourceFile])})`,
    `[Copy Link](${commandUri('frilvault.gutter.copyLink', [noteId, sourceFile])})`,
    `[Copy Content](${commandUri(COMMAND_IDS.gutterCopyNoteContent, [noteId, sourceFile])})`,
    `[Copy Markdown](${commandUri(COMMAND_IDS.gutterCopyNoteMarkdown, [noteId, sourceFile])})`,
  ];

  if (multipleNotes) {
    links.unshift(
      `[Choose note…](${commandUri('frilvault.gutter.showActions', [0, sourceFile])})`,
    );
  }

  markdown.appendMarkdown(`${links.join(' · ')}\n`);
}

function createContentMarkdown(): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = { enabledCommands: [COMMAND_IDS.searchNotesByTag] };
  markdown.supportHtml = false;
  return markdown;
}

function createTrustedActionsMarkdown(): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = { enabledCommands: [...NOTE_HOVER_COMMANDS] };
  markdown.supportHtml = false;
  return markdown;
}

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleDateString();
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function commandUri(command: string, args: unknown[]): string {
  if (!NOTE_HOVER_COMMANDS.includes(command as (typeof NOTE_HOVER_COMMANDS)[number])) {
    throw new Error(`Untrusted hover command: ${command}`);
  }

  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}
