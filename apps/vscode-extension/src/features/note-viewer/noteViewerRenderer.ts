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
  formatExpandedPreview,
  formatGroupTags,
  groupNoteViewerItems,
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

      lenses.push(
        this.commandLens(
          range,
          '+',
          COMMAND_IDS.noteViewerAddOrEdit,
          [group.items[0].sourceFile, documentUri, group.anchor, group.anchorLine],
          'Add or edit the note at this anchor',
        ),
      );

      lenses.push(
        this.commandLens(
          range,
          allCollapsed ? '▶' : `▼ ${formatExpandedPreview(group)}`,
          COMMAND_IDS.noteViewerToggle,
          [noteIds, documentUri],
          allCollapsed ? 'Expand note preview' : 'Collapse note preview',
        ),
      );

      for (const tag of formatGroupTags(group)) {
        lenses.push(
          this.commandLens(
            range,
            tag,
            COMMAND_IDS.noteViewerNoop,
            [],
            `Note tag ${tag}`,
          ),
        );
      }

      lenses.push(
        this.commandLens(
          range,
          '−',
          COMMAND_IDS.noteViewerDelete,
          [noteIds, group.items[0].sourceFile, documentUri],
          'Delete a note at this anchor',
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

function truncateLine(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_CODE_LENS_LINE_LENGTH) {
    return value;
  }

  return `${characters.slice(0, MAX_CODE_LENS_LINE_LENGTH - 1).join('').trimEnd()}…`;
}
