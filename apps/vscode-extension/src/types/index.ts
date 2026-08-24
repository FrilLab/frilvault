/**
 * JSON shapes returned by the FrilVault CLI.
 *
 * These mirror `frilvault-core` read models. The extension treats them as the
 * boundary between CLI output and UI state.
 *
 * FrilVault CLI가 반환하는 JSON shape입니다.
 *
 * `frilvault-core` read model과 대응하며, extension은 CLI output과 UI state
 * 사이의 경계로 사용합니다.
 */
export type NoteAnchor = {
  type: 'Line' | 'Symbol';
  line?: number;
  column?: number;
  name?: string;
  kind?: string;
  signature?: string;
  line_hint?: number;
};

export type NoteAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  extension: string;
};

/** Current resolved coordinates for a symbol note anchor. */
export type ResolvedSymbol = {
  line: number;
  column: number;
};

/**
 * Note plus source-file context returned by list/search/update/add commands.
 *
 * list/search/update/add command가 반환하는 source file context 포함 note입니다.
 */
export type NoteView = {
  source_file: string;
  note: {
    id: string;
    title?: string;
    content: string;
    anchor: NoteAnchor;
    tags?: string[];
    priority?: number;
    decision_metadata?: string;
    attachments?: NoteAttachment[];
    created_at?: string;
    updated_at?: string;
  };
  resolved?: ResolvedSymbol;
};

export interface WorkspaceStats {
  file_count: number;
  total_notes: number;
  existing_files: number;
  missing_files: number;
  line_notes: number;
  symbol_notes: number;
}

export interface WorkspaceHealth {
  missing_source_files: string[];
}

export interface RepairSuggestion {
  missing_file: string;
  candidates: string[];
}

export interface SyncResult {
  notes_synced: boolean;
  repairs_applied: number;
}

export interface IndexedFile {
  source_file: string;
  note_count: number;
  exists: boolean;
}

export interface WorkspaceIndex {
  version: number;
  files: IndexedFile[];
}

export interface ExplorerGroup {
  type: 'LineNotes' | 'SymbolNotes';
  notes: Array<{ id: string }>;
}

export type WorkspaceExplorerNode =
  | {
      type: 'Directory';
      name: string;
      path: string;
      children: WorkspaceExplorerNode[];
    }
  | {
      type: 'File';
      source_file: string;
      exists: boolean;
      groups: ExplorerGroup[];
    };

export interface WorkspaceExplorer {
  root: WorkspaceExplorerNode;
}

export interface MutationResult {
  note: NoteView['note'] | null;
}

export interface TagOperationResult {
  affected_notes: number;
  affected_files: number;
}

export interface TagSummary {
  tag: string;
  note_count: number;
  color?: TagColor;
}

export type TagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
