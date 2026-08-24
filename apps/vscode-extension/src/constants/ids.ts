/**
 * Shared VS Code extension identifiers.
 *
 * Keep `package.json` contributes/activation values aligned with these constants.
 *
 * VS Code extension identifier의 단일 출처입니다.
 *
 * `package.json` contributes/activation 값은 이 상수와 일치해야 합니다.
 */
export const VIEW_IDS = {
  notes: 'frilvault.notes',
  tags: 'frilvault.tags',
} as const;

export const COMMAND_IDS = {
  addNote: 'frilvault.addNote',
  editNote: 'frilvault.editNote',
  enable: 'frilvault.enable',
  disable: 'frilvault.disable',
  refresh: 'frilvault.refresh',
  searchNotes: 'frilvault.searchNotes',
  searchNotesByTag: 'frilvault.searchNotesByTag',
  setTagColor: 'frilvault.setTagColor',
  removeTagColor: 'frilvault.removeTagColor',
  showNotesForCurrentFile: 'frilvault.showNotesForCurrentFile',
  notesPanelOpenNote: 'frilvault.notesPanel.openNote',
  notesPanelEditNote: 'frilvault.notesPanel.editNote',
  gutterShowActions: 'frilvault.gutter.showActions',
  gutterViewNote: 'frilvault.gutter.viewNote',
  gutterEditNote: 'frilvault.gutter.editNote',
  gutterDeleteNote: 'frilvault.gutter.deleteNote',
  gutterCopyLink: 'frilvault.gutter.copyLink',
  gutterCopyNoteContent: 'frilvault.gutter.copyNoteContent',
  gutterCopyNoteMarkdown: 'frilvault.gutter.copyNoteMarkdown',
  noteViewerToggle: 'frilvault.noteViewer.toggle',
} as const;

export const CONTEXT_KEYS = {
  enabled: 'frilvault.enabled',
} as const;

export const VIEW_ITEM_CONTEXT = {
  note: 'frilvault.note',
  notesFileHeader: 'frilvault.notesFileHeader',
  notesStatus: 'frilvault.notesStatus',
  notesLineGroup: 'frilvault.notesLineGroup',
  notesSymbolGroup: 'frilvault.notesSymbolGroup',
  notesUnresolvedGroup: 'frilvault.notesUnresolvedGroup',
  tag: 'frilvault.tag',
  tagNote: 'frilvault.tagNote',
} as const;

/** VS Code focus command for the notes sidebar view. */
export function notesViewFocusCommand(): string {
  return `${VIEW_IDS.notes}.focus`;
}

/** Activation event emitted when the notes view becomes visible. */
export function notesViewActivationEvent(): string {
  return `onView:${VIEW_IDS.notes}`;
}

/** Activation event emitted when the tags view becomes visible. */
export function tagsViewActivationEvent(): string {
  return `onView:${VIEW_IDS.tags}`;
}
