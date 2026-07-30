import * as vscode from 'vscode';

import type { NoteViewerDefaultState } from './config';

export class NoteViewerState implements vscode.Disposable {
  private readonly overridesByDocument = new Map<string, Map<string, boolean>>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  public readonly onDidChange = this.onDidChangeEmitter.event;

  public isExpanded(
    documentUri: string,
    groupId: string,
    defaultState: NoteViewerDefaultState,
  ): boolean {
    const overrides = this.overridesByDocument.get(documentUri);
    const override = overrides?.get(groupId);

    if (typeof override === 'boolean') {
      return override;
    }

    return defaultState === 'expanded';
  }

  public toggle(
    documentUri: string,
    groupId: string,
    defaultState: NoteViewerDefaultState,
  ): void {
    const overrides = this.overridesByDocument.get(documentUri) ?? new Map<string, boolean>();
    const shouldExpand = !this.isExpanded(documentUri, groupId, defaultState);

    if (
      (defaultState === 'collapsed' && shouldExpand)
      || (defaultState === 'expanded' && !shouldExpand)
    ) {
      overrides.set(groupId, shouldExpand);
    } else {
      overrides.delete(groupId);
    }

    if (overrides.size === 0) {
      this.overridesByDocument.delete(documentUri);
    } else {
      this.overridesByDocument.set(documentUri, overrides);
    }

    this.onDidChangeEmitter.fire();
  }

  public clearDocument(documentUri: string): void {
    if (this.overridesByDocument.delete(documentUri)) {
      this.onDidChangeEmitter.fire();
    }
  }

  public retainVisibleEditors(editors: readonly vscode.TextEditor[]): void {
    const visibleUris = new Set(
      editors
        .filter((editor) => editor.document.uri.scheme === 'file')
        .map((editor) => editor.document.uri.toString()),
    );
    let changed = false;

    for (const uri of this.overridesByDocument.keys()) {
      if (!visibleUris.has(uri)) {
        this.overridesByDocument.delete(uri);
        changed = true;
      }
    }

    if (changed) {
      this.onDidChangeEmitter.fire();
    }
  }

  public dispose(): void {
    this.overridesByDocument.clear();
    this.onDidChangeEmitter.dispose();
  }
}
