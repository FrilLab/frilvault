import * as vscode from 'vscode';

import type { CurrentFileNotesStore } from '../current-file/store';
import { formatFullMarkdownNoteHover } from '../presentation/noteHover';
import { resolveNotesAtPosition } from './resolveNotes';

export class FrilVaultHoverProvider implements vscode.HoverProvider {
  private hoverGeneration = 0;

  public constructor(
    private readonly store: CurrentFileNotesStore,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!this.isEnabled() || document.uri.scheme !== 'file') {
      return undefined;
    }

    const snapshot = this.store.getSnapshot();
    const notes = this.store.notesForDocument(document);

    if (notes.length === 0 || snapshot.loading) {
      return undefined;
    }

    const generation = ++this.hoverGeneration;
    const resolved = await resolveNotesAtPosition(notes, document, position, token);

    if (
      token.isCancellationRequested ||
      generation !== this.hoverGeneration ||
      !resolved
    ) {
      return undefined;
    }

    const markdown = formatFullMarkdownNoteHover(resolved.notes);
    return markdown ? new vscode.Hover(markdown, resolved.range) : undefined;
  }
}
