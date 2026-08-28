/**
 * Renders note viewer items as VS Code editor decorations.
 *
 * Uses `before` decorations to display note content above the associated
 * source-code anchor. Collapsed notes show a compact one-line indicator;
 * expanded notes show multi-line content.
 *
 * VS Code editor decoration을 사용하여 note viewer item을 렌더링합니다.
 */
import * as vscode from 'vscode';

import type { NoteViewerGroup, NoteViewerItem } from './noteViewerModel';
import { formatCollapsedSummary, formatExpandedContent, groupNoteViewerItems } from './noteViewerModel';

const MAX_EXPANDED_PREVIEW_LINES = 20;

export class NoteViewerRenderer implements vscode.Disposable {
  private collapsedDecorationType: vscode.TextEditorDecorationType;
  private expandedDecorationType: vscode.TextEditorDecorationType;

  public constructor() {
    this.collapsedDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
    });

    this.expandedDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
      },
    });
  }

  public render(editor: vscode.TextEditor, items: NoteViewerItem[]): void {
    const groups = groupNoteViewerItems(items);
    const collapsedDecorations: vscode.DecorationOptions[] = [];
    const expandedDecorations: vscode.DecorationOptions[] = [];

    for (const group of groups) {
      const zeroBasedLine = group.anchorLine - 1;

      if (zeroBasedLine < 0 || zeroBasedLine >= editor.document.lineCount) {
        continue;
      }

      const range = new vscode.Range(zeroBasedLine, 0, zeroBasedLine, 0);
      const allCollapsed = group.items.every((item) => item.collapsed);

      if (allCollapsed) {
        collapsedDecorations.push({
          range,
          renderOptions: {
            before: {
              contentText: formatCollapsedSummary(group),
            },
          },
        });
      } else {
        const lines = buildExpandedText(group);
        expandedDecorations.push({
          range,
          renderOptions: {
            before: {
              contentText: lines,
            },
          },
        });
      }
    }

    editor.setDecorations(this.collapsedDecorationType, collapsedDecorations);
    editor.setDecorations(this.expandedDecorationType, expandedDecorations);
  }

  public clear(editor?: vscode.TextEditor): void {
    editor?.setDecorations(this.collapsedDecorationType, []);
    editor?.setDecorations(this.expandedDecorationType, []);
  }

  public dispose(): void {
    this.collapsedDecorationType.dispose();
    this.expandedDecorationType.dispose();
  }
}

function buildExpandedText(group: NoteViewerGroup): string {
  const parts: string[] = [];

  if (group.items.length === 1) {
    const item = group.items[0];
    parts.push(`▼ Note`);
    parts.push('');
    parts.push(formatExpandedContent(item, MAX_EXPANDED_PREVIEW_LINES));

    if (item.tags.length > 0) {
      parts.push('');
      parts.push(item.tags.slice(0, 5).map((tag) => `#${tag}`).join(' '));
    }
  } else {
    parts.push(`▼ Notes (${group.items.length})`);
    parts.push('');

    for (const [index, item] of group.items.entries()) {
      if (index > 0) {
        parts.push('');
      }

      const title = item.title || 'Note';
      parts.push(`[${index + 1}] ${title}`);
      parts.push(`    ${formatExpandedContent(item, Math.min(MAX_EXPANDED_PREVIEW_LINES, 5))}`);

      if (item.tags.length > 0) {
        parts.push(`    ${item.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ')}`);
      }
    }
  }

  return parts.join('\n');
}
