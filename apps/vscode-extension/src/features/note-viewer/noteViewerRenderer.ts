/**
 * Renders note viewer items as CodeLens rows.
 *
 * VS Code's supported editor APIs do not provide an extension-owned block
 * widget in a text editor. CodeLens provides compact rows between source
 * lines, so the viewer uses one summary or preview row per anchor. This keeps
 * the source document untouched and makes the collapse control a
 * real VS Code command rather than relying on decoration pseudo-elements.
 */
import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../constants/ids';
import {
  formatCollapsedSummary,
  groupNoteViewerItems,
  normalizeTags,
  type NoteViewerGroup,
  type NoteViewerItem,
} from './noteViewerModel';

const MAX_CODE_LENS_LINE_LENGTH = 144;

export class NoteViewerRenderer implements vscode.Disposable {
  /**
   * Build CodeLens previews for a document. Every command carries the stable note
   * id(s) and document URI needed when an editor is split or changes focus.
   */
  public render(document: vscode.TextDocument, items: NoteViewerItem[]): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];

    for (const group of groupNoteViewerItems(items)) {
      const line = group.anchorLine - 1;

      if (line < 0 || line >= document.lineCount) {
        continue;
      }

      const range = new vscode.Range(line, 0, line, 0);
      const documentUri = document.uri.toString();
      const noteIds = group.items.map((item) => item.noteId);
      const allCollapsed = group.items.every((item) => item.collapsed);

      const title = allCollapsed ? formatCollapsedSummary(group) : formatExpandedPreview(group);
      lenses.push(
        this.commandLens(
          range,
          title,
          COMMAND_IDS.noteViewerToggle,
          [noteIds, documentUri],
          allCollapsed ? 'Show a short FrilVault note preview' : 'Hide the FrilVault note preview',
        ),
      );

      // Keep actions available without rendering the full note above source.
      lenses.push(
        this.commandLens(
          range,
          '$(kebab-vertical) Actions…',
          COMMAND_IDS.noteViewerActions,
          [noteIds, group.items[0].sourceFile],
          'Open note actions',
        ),
      );
    }

    return lenses;
  }

  public dispose(): void {
    // CodeLens resources are owned by VS Code; there are no decoration types
    // or per-document registrations to dispose here.
  }

  private commandLens(
    range: vscode.Range,
    title: string,
    command: string,
    args: unknown[],
    tooltip: string,
  ): vscode.CodeLens {
    return new vscode.CodeLens(range, {
      title: truncateLine(title),
      command,
      arguments: args,
      tooltip,
    });
  }
}

function formatExpandedPreview(group: NoteViewerGroup): string {
  const preview = group.items
    .map((item) => item.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  const summary = group.totalCount === 1 ? '▼ Note' : `▼ Notes (${group.totalCount})`;
  return preview ? `${summary} · ${preview}` : `${summary} · empty`;
}

function truncateLine(value: string): string {
  if (value.length <= MAX_CODE_LENS_LINE_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_CODE_LENS_LINE_LENGTH - 1).trimEnd()}…`;
}
