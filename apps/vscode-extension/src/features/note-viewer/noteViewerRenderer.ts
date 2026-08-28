/**
 * Renders note viewer items as CodeLens rows.
 *
 * VS Code's supported editor APIs do not provide an extension-owned block
 * widget in a text editor. CodeLens does provide dedicated horizontal rows
 * between source lines, so the viewer uses one CodeLens per displayed line.
 * This keeps the source document untouched and makes the collapse control a
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

const MAX_CODE_LENS_LINE_LENGTH = 240;

export class NoteViewerRenderer implements vscode.Disposable {
  /**
   * Build CodeLens rows for a document. Every command carries the stable note
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

      if (allCollapsed) {
        lenses.push(
          this.commandLens(
            range,
            formatCollapsedSummary(group),
            COMMAND_IDS.noteViewerToggle,
            [noteIds, documentUri],
            'Expand FrilVault note',
          ),
        );
      } else {
        lenses.push(
          this.commandLens(
            range,
            formatExpandedHeading(group),
            COMMAND_IDS.noteViewerToggle,
            [noteIds, documentUri],
            'Collapse FrilVault note',
          ),
        );

        for (const [index, item] of group.items.entries()) {
          if (group.items.length > 1) {
            lenses.push(this.textLens(range, `[${index + 1}] ${item.title || 'Note'}`));
          }

          if (item.collapsed) {
            lenses.push(
              this.commandLens(
                range,
                formatCollapsedSummary({
                  anchorLine: group.anchorLine,
                  items: [item],
                  totalCount: 1,
                }),
                COMMAND_IDS.noteViewerToggle,
                [[item.noteId], documentUri],
                'Expand FrilVault note',
              ),
            );
            continue;
          }

          for (const contentLine of splitContent(item.content)) {
            lenses.push(this.textLens(range, contentLine));
          }

          const tags = normalizeTags(item.tags);
          if (tags.length > 0) {
            lenses.push(this.textLens(range, tags.slice(0, 5).map((tag) => `#${tag}`).join(' ')));
          }
        }
      }

      // The existing hover and gutter action surfaces remain the primary action
      // UI. This compact action entry point makes all actions reachable from
      // the block itself without repeating a toolbar for every note.
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

  private textLens(range: vscode.Range, text: string): vscode.CodeLens {
    return new vscode.CodeLens(range, {
      title: truncateLine(text) || ' ',
      command: COMMAND_IDS.noteViewerNoop,
      arguments: [],
      tooltip: 'FrilVault note content',
    });
  }
}

function formatExpandedHeading(group: NoteViewerGroup): string {
  return group.totalCount === 1 ? '▼ Note' : `▼ Notes (${group.totalCount})`;
}

function splitContent(content: string): string[] {
  // An empty note still gets one visible row, while CRLF is normalized only
  // for presentation and never written back to the source document.
  return content.replace(/\r\n/g, '\n').split('\n');
}

function truncateLine(value: string): string {
  if (value.length <= MAX_CODE_LENS_LINE_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_CODE_LENS_LINE_LENGTH - 1).trimEnd()}…`;
}
