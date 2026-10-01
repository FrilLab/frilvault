const STATE_KEY = 'frilvault.noteViewer.collapse.v1';

/** Tracks explicit per-note disclosure choices in the current workspace. */
export class NoteViewerState {
  private readonly stateByDocument = new Map<string, Map<string, boolean>>();
  private persistence: import('vscode').Memento | undefined;

  public setPersistence(persistence: import('vscode').Memento): void {
    this.persistence = persistence;
  }

  /** Returns whether the note is collapsed. Falls back to the given default. */
  public isCollapsed(documentUri: string, noteId: string, defaultCollapsed: boolean): boolean {
    return this.stateByDocument.get(documentUri)?.get(noteId)
      ?? this.persistedState()[documentUri]?.[noteId]
      ?? defaultCollapsed;
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
    const state = this.persistedState();
    state[documentUri] = { ...state[documentUri], [noteId]: collapsed };
    void this.persistence?.update(STATE_KEY, state);
  }

  /** Clears the memory cache while retaining the saved disclosure choice. */
  public clearDocument(documentUri: string): void {
    this.stateByDocument.delete(documentUri);
  }

  /** Clears memory caches without deleting explicit workspace choices. */
  public clear(): void {
    this.stateByDocument.clear();
  }

  private persistedState(): Record<string, Record<string, boolean>> {
    return this.persistence?.get<Record<string, Record<string, boolean>>>(STATE_KEY, {}) ?? {};
  }
}
