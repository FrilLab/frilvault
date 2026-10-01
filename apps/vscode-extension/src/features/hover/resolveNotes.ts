import * as vscode from 'vscode';

import type { NoteView } from '../../types';
import {
  findSymbolDeclarationAtPosition,
  mapDocumentSymbolKind,
  readSymbolSignature,
} from '../../utils/symbols';
import { deduplicateNotesById } from '../presentation/deduplicateNotes';

export interface HoverSymbolDeclaration {
  name: string;
  kind: string;
  signature?: string;
  line: number;
  range: vscode.Range;
}

export interface ResolvedHoverNotes {
  notes: NoteView[];
  range: vscode.Range;
}

export function sortNotesForHover(notes: NoteView[]): NoteView[] {
  return [...notes].sort((left, right) => {
    const priorityComparison = comparePriority(left, right);
    if (priorityComparison !== 0) {
      return priorityComparison;
    }

    const kindComparison = anchorKindOrder(left) - anchorKindOrder(right);
    if (kindComparison !== 0) {
      return kindComparison;
    }

    const updatedComparison = compareUpdatedAt(left, right);
    if (updatedComparison !== 0) {
      return updatedComparison;
    }

    return left.note.id.localeCompare(right.note.id);
  });
}

export async function resolveNotesAtPosition(
  notes: NoteView[],
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
): Promise<ResolvedHoverNotes | undefined> {
  const lineRange = lineHoverRangeAtPosition(document, position);
  const hasSymbolNotes = notes.some((note) => note.note.anchor.type === 'Symbol');
  const symbol = hasSymbolNotes
    ? await findSymbolDeclarationAtPosition(document, position)
    : undefined;

  if (token.isCancellationRequested) {
    return undefined;
  }

  const declaration = symbol
    ? {
        name: symbol.name,
        kind: mapDocumentSymbolKind(symbol.kind),
        signature: readSymbolSignature(document, symbol),
        line: symbol.range.start.line + 1,
        range: symbol.selectionRange,
      }
    : undefined;
  const includeLineNotes = lineRange !== undefined;
  const matched = resolveNotesFromCache(notes, position, declaration, includeLineNotes);

  if (matched.length === 0) {
    return undefined;
  }

  const hasLineNote = matched.some((note) => note.note.anchor.type === 'Line');
  const range = hasLineNote ? lineRange : declaration?.range;

  return range ? { notes: matched, range } : undefined;
}

export function resolveNotesFromCache(
  notes: NoteView[],
  position: vscode.Position,
  declaration?: HoverSymbolDeclaration,
  includeLineNotes = true,
): NoteView[] {
  const symbolMatches = declaration
    ? notes.filter((note) => isResolvedSymbolAtDeclaration(note, declaration))
    : [];
  const lineMatches = includeLineNotes
    ? notes.filter(
        (note) =>
          note.note.anchor.type === 'Line' &&
          (note.note.anchor.line ?? 1) - 1 === position.line,
      )
    : [];

  return deduplicateNotesById(sortNotesForHover([...symbolMatches, ...lineMatches]));
}

function isResolvedSymbolAtDeclaration(
  note: NoteView,
  declaration: HoverSymbolDeclaration,
): boolean {
  const anchor = note.note.anchor;
  return anchor.type === 'Symbol' &&
    note.resolved?.line === declaration.line &&
    anchor.name === declaration.name &&
    normalizeSymbolKind(anchor.kind) === normalizeSymbolKind(declaration.kind);
}

export function lineHoverRangeAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Range | undefined {
  const line = document.lineAt(position.line);
  const end = line.text.trimEnd().length;
  const start = line.firstNonWhitespaceCharacterIndex;

  if (end === 0 || start < 0 || start >= end) {
    if (position.character <= line.text.length) {
      return new vscode.Range(position.line, 0, position.line, line.text.length);
    }
    return undefined;
  }

  if (position.character < start || position.character >= end) {
    return undefined;
  }
  return new vscode.Range(position.line, start, position.line, end);
}

function normalizeSymbolKind(kind: string | undefined): string {
  return kind?.toLocaleLowerCase() ?? 'unknown';
}

function anchorKindOrder(note: NoteView): number {
  return note.note.anchor.type === 'Symbol' ? 0 : 1;
}

function comparePriority(left: NoteView, right: NoteView): number {
  const leftPriority = left.note.priority ?? 0;
  const rightPriority = right.note.priority ?? 0;

  return rightPriority - leftPriority;
}

function compareUpdatedAt(left: NoteView, right: NoteView): number {
  const leftUpdated = left.note.updated_at ?? '';
  const rightUpdated = right.note.updated_at ?? '';

  return rightUpdated.localeCompare(leftUpdated);
}
