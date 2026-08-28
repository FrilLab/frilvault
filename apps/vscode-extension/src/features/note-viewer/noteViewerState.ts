import type { NoteViewerItem } from './noteViewerModel';

/**
 * Tracks per-document collapse/expand state for note viewer items.
 *
 * State is ephemeral — cleared when the document is closed.
 */
export class NoteViewerState {
  /** Map from document URI to Map from noteId to collapsed boolean. */
  private readonly stateByDocument = new Map<string, Map<string, boolean>>();

  /** Returns whether the note is collapsed. Falls back to the given default. */
  public isCollapsed(documentUri: string, noteId: string, defaultCollapsed: boolean): boolean {
    return this.stateByDocument.get(documentUri)?.get(noteId) ?? defaultCollapsed;
  }

  /** Toggles the collapsed state for a specific note. */
  public toggle(documentUri: string, noteId: string, currentCollapsed: boolean): void {
    this.set(documentUri, noteId, !currentCollapsed);
  }

  /** Sets the collapsed state for a specific note. */
  public set(documentUri: string, noteId: string, collapsed: boolean): void {
    let docState = this.stateByDocument.get(documentUri);
    if (!docState) {
      docState = new Map();
      this.stateByDocument.set(documentUri, docState);
    }
    docState.set(noteId, collapsed);
  }

  /** Clears state for a specific document. */
  public clearDocument(documentUri: string): void {
    this.stateByDocument.delete(documentUri);
  }

  /** Clears all state. */
  public clear(): void {
    this.stateByDocument.clear();
  }
}
