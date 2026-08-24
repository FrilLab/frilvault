import type { NoteView, WorkspaceExplorerNode } from '../../types';
import { createInlinePreview } from '../presentation/inlinePreview';
import { formatTagList } from '../presentation/tagPresentation';

export interface SymbolNoteGroup {
  name: string;
  notes: NoteView[];
}

export interface NotesAnchorGroups {
  symbolGroups: SymbolNoteGroup[];
  lineNotes: NoteView[];
  unresolvedNotes: NoteView[];
}

export interface WorkspaceTreeFolder {
  kind: 'folder';
  path: string;
  name: string;
  noteCount: number;
  children: WorkspaceTreeNode[];
}

export interface WorkspaceTreeFile {
  kind: 'file';
  path: string;
  name: string;
  noteCount: number;
}

export type WorkspaceTreeNode = WorkspaceTreeFolder | WorkspaceTreeFile;

/** Groups current-file notes by symbol name, line anchor, and unresolved symbol anchors. */
export function groupNotesByAnchor(notes: NoteView[]): NotesAnchorGroups {
  const lineNotes = notes
    .filter((note) => note.note.anchor.type === 'Line')
    .sort((left, right) => (left.note.anchor.line ?? 0) - (right.note.anchor.line ?? 0));

  const symbolNotes = notes.filter((note) => note.note.anchor.type === 'Symbol');
  const unresolvedNotes = symbolNotes
    .filter((note) => !note.resolved)
    .sort((left, right) =>
      (left.note.anchor.name ?? '').localeCompare(right.note.anchor.name ?? ''),
    );

  const resolvedByName = new Map<string, NoteView[]>();

  for (const note of symbolNotes.filter((entry) => entry.resolved)) {
    const name = note.note.anchor.name ?? 'Symbol';
    const group = resolvedByName.get(name) ?? [];
    group.push(note);
    resolvedByName.set(name, group);
  }

  const symbolGroups = [...resolvedByName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, groupNotes]) => ({ name, notes: groupNotes }));

  return { symbolGroups, lineNotes, unresolvedNotes };
}

export function truncateNoteContent(content: string, maxLength = 60): string {
  return createInlinePreview(content, maxLength);
}

export function formatNoteQuickPickDescription(noteView: NoteView): string {
  if (noteView.note.anchor.type === 'Line') {
    return `Line ${noteView.note.anchor.line ?? 1}`;
  }

  const resolvedLine = noteView.resolved?.line ?? noteView.note.anchor.line_hint;
  const lineLabel = typeof resolvedLine === 'number' ? `Line ${resolvedLine}` : 'Unresolved';
  const name = noteView.note.anchor.name ?? 'Symbol';

  return `${lineLabel} · ${name}`;
}

export function formatNoteQuickPickDetail(noteView: NoteView): string | undefined {
  const tags = formatTagList(noteView.note.tags);

  if (tags) {
    return `Tags: ${tags}`;
  }

  if (noteView.note.updated_at) {
    return `Updated ${noteView.note.updated_at}`;
  }

  return undefined;
}

export function noteQuickPickLabel(noteView: NoteView): string {
  return truncateNoteContent(noteView.note.content);
}

export function buildWorkspaceNoteTreeFromExplorer(
  root: WorkspaceExplorerNode,
): WorkspaceTreeNode[] {
  if (root.type !== 'Directory') {
    return [];
  }

  return root.children
    .map((child) => mapExplorerNode(child))
    .filter((node): node is WorkspaceTreeNode => node !== undefined)
    .sort(compareWorkspaceNodes);
}

function mapExplorerNode(node: WorkspaceExplorerNode): WorkspaceTreeNode | undefined {
  if (node.type === 'File') {
    const noteCount = node.groups.reduce((sum, group) => sum + group.notes.length, 0);

    if (noteCount <= 0) {
      return undefined;
    }

    return {
      kind: 'file',
      path: node.source_file,
      name: node.source_file.split('/').pop() ?? node.source_file,
      noteCount,
    };
  }

  const children = node.children
    .map((child) => mapExplorerNode(child))
    .filter((child): child is WorkspaceTreeNode => child !== undefined)
    .sort(compareWorkspaceNodes);
  const noteCount = children.reduce((sum, child) => sum + child.noteCount, 0);

  if (noteCount <= 0) {
    return undefined;
  }

  return {
    kind: 'folder',
    path: node.path,
    name: node.name,
    noteCount,
    children,
  };
}

function compareWorkspaceNodes(left: WorkspaceTreeNode, right: WorkspaceTreeNode): number {
  if (left.kind !== right.kind) {
    return left.kind === 'folder' ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}
