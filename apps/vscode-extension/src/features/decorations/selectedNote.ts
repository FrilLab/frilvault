import * as path from 'node:path';

import * as vscode from 'vscode';

import { sourceBreakpointLines } from './decorator';

export interface SelectedAnchor {
  documentUri: string;
  line: number;
}

export function selectedNoteLine(
  selected: SelectedAnchor | undefined,
  documentUri: string,
  lineCount: number,
  breakpointLines: ReadonlySet<number>,
): number | undefined {
  if (
    !selected ||
    selected.documentUri !== documentUri ||
    selected.line < 0 ||
    selected.line >= lineCount ||
    breakpointLines.has(selected.line)
  ) {
    return undefined;
  }
  return selected.line;
}

/** Highlights the last note opened from a tree without taking over breakpoints. */
export class SelectedNoteHighlighter implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly breakpointListener: vscode.Disposable;
  private readonly editorListener: vscode.Disposable;
  private selected: SelectedAnchor | undefined;

  public constructor(extensionPath: string) {
    const lightIcon = vscode.Uri.file(path.join(
      extensionPath,
      'media',
      'frilvault-selected-marker-light.svg',
    ));
    const darkIcon = vscode.Uri.file(path.join(
      extensionPath,
      'media',
      'frilvault-selected-marker-dark.svg',
    ));
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      backgroundColor: new vscode.ThemeColor('editor.lineHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      gutterIconPath: lightIcon,
      gutterIconSize: 'contain',
      light: { gutterIconPath: lightIcon },
      dark: { gutterIconPath: darkIcon },
    });
    this.breakpointListener = vscode.debug.onDidChangeBreakpoints(() => this.refresh());
    this.editorListener = vscode.window.onDidChangeVisibleTextEditors(() => this.refresh());
  }

  public select(documentUri: string, line: number): void {
    this.selected = { documentUri, line };
    this.refresh();
  }

  public clear(): void {
    this.selected = undefined;
    this.refresh();
  }

  public dispose(): void {
    this.breakpointListener.dispose();
    this.editorListener.dispose();
    this.decoration.dispose();
    this.selected = undefined;
  }

  private refresh(): void {
    const selected = this.selected;
    for (const editor of vscode.window.visibleTextEditors) {
      const selectedLine = selectedNoteLine(
        selected,
        editor.document.uri.toString(),
        editor.document.lineCount,
        selected ? sourceBreakpointLines(selected.documentUri) : new Set(),
      );
      if (selectedLine === undefined) {
        editor.setDecorations(this.decoration, []);
        continue;
      }

      const range = editor.document.lineAt(selectedLine).range;
      editor.setDecorations(this.decoration, [{ range }]);
    }
  }
}
