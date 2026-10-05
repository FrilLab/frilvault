/**
 * Renders note viewer items as CodeLens rows.
 *
 * VS Code's supported editor APIs do not provide an extension-owned block
 * widget in a text editor. CodeLens provides compact controls between source
 * lines, while a line decoration shows the expanded first-line preview to the
 * right of its source anchor. The source document stays untouched.
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
   * Build CodeLens controls for a document. Every command carries the stable note
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
          allCollapsed ? '▶' : '▼',
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

export function buildExpandedPreviewDecorations(
  document: vscode.TextDocument,
  items: NoteViewerItem[],
): vscode.DecorationOptions[] {
  const decorations: vscode.DecorationOptions[] = [];
  for (const group of groupNoteViewerItems(items)) {
    if (group.items.every((item) => item.collapsed)) {
      continue;
    }

    const line = group.anchorLine - 1;
    if (line < 0 || line >= document.lineCount) {
      continue;
    }
    const preview = formatExpandedPreview(group);
    if (!preview) {
      continue;
    }
    const sourceLine = document.lineAt(line);
    decorations.push({
      range: sourceLine.range,
      renderOptions: {
        after: {
          contentText: `  ${preview}`,
        },
      },
    });
  }
  return decorations;
}

function truncateLine(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_CODE_LENS_LINE_LENGTH) {
    return value;
  }

  return `${characters.slice(0, MAX_CODE_LENS_LINE_LENGTH - 1).join('').trimEnd()}…`;
}
