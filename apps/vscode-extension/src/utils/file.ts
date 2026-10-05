import * as path from 'node:path';
import { existsSync, statSync } from 'node:fs';

import * as vscode from 'vscode';

import type { NoteView } from '../types';

export function tryGetWorkspaceRoot(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<string>('workspaceRoot', '')
    .trim();

  if (configured.length > 0) {
    return configured;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Resolve the invoking source editor's folder, honoring the explicit override. */
export function getWorkspaceRootForSource(uri: vscode.Uri): string {
  const configured = vscode.workspace.getConfiguration('frilvault')
    .get<string>('workspaceRoot', '').trim();
  const root = configured || vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  if (!root) {
    throw new Error('Open a source file in a workspace folder to add or edit a note.');
  }
  return root;
}

export function getWorkspaceRoot(): string {
  const workspaceRoot = tryGetWorkspaceRoot();

  if (!workspaceRoot) {
    throw new Error('FrilVault requires an open workspace folder.');
  }

  return workspaceRoot;
}

export function tryGetVaultPath(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('frilvault')
    .get<string>('vaultPath', '')
    .trim();

  return configured.length > 0 ? configured : undefined;
}

const resolvedVaultRoots = new Map<string, string>();

export function rememberResolvedVaultRoot(
  workspaceRoot: string,
  configuredVaultPath: string | undefined,
  reportedVaultPath: string,
): void {
  const key = vaultRootCacheKey(workspaceRoot, configuredVaultPath);
  if (!path.isAbsolute(reportedVaultPath)) {
    resolvedVaultRoots.delete(key);
    return;
  }

  resolvedVaultRoots.set(key, path.resolve(reportedVaultPath));
}

export function getVaultRoot(workspaceRoot: string): string {
  const configured = tryGetVaultPath();

  if (configured) {
    return path.resolve(workspaceRoot, configured);
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedVaultRoot = resolvedVaultRoots.get(
    vaultRootCacheKey(resolvedWorkspaceRoot, configured),
  );
  if (resolvedVaultRoot) {
    return resolvedVaultRoot;
  }

  let directory = resolvedWorkspaceRoot;

  while (true) {
    const candidate = path.join(directory, '.vault');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return path.join(resolvedWorkspaceRoot, '.vault');
}

function vaultRootCacheKey(workspaceRoot: string, configuredVaultPath: string | undefined): string {
  return `${path.resolve(workspaceRoot)}\0${configuredVaultPath ?? ''}`;
}

export function getActiveEditorOrThrow(): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    throw new Error('No active editor.');
  }

  if (editor.document.uri.scheme !== 'file') {
    throw new Error('FrilVault only supports files on disk.');
  }

  return editor;
}

export function normalizeWorkspaceRelativePath(relative: string): string {
  return relative.split(path.sep).join('/');
}

export function tryGetRelativeFilePath(
  workspaceRoot: string,
  sourceFile: string,
): string | undefined {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedFile = path.resolve(sourceFile);
  const relative = path.relative(resolvedRoot, resolvedFile);

  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }

  return normalizeWorkspaceRelativePath(relative);
}

export function getRelativePathForDocument(
  document: vscode.TextDocument,
  workspaceRoot?: string,
): string | undefined {
  if (document.uri.scheme !== 'file') {
    return undefined;
  }

  const root = workspaceRoot ?? tryGetWorkspaceRoot();

  if (!root) {
    return undefined;
  }

  return tryGetRelativeFilePath(root, document.uri.fsPath);
}

export function getRelativeFilePath(workspaceRoot: string, sourceFile: string): string {
  const relative = tryGetRelativeFilePath(workspaceRoot, sourceFile);

  if (!relative) {
    throw new Error('The active file must be inside the current workspace.');
  }

  return relative;
}

export async function revealNote(
  note: NoteView,
  workspaceRoot: string,
): Promise<{ editor: vscode.TextEditor; line: number } | undefined> {
  if (note.note.anchor.type === 'Symbol' && !note.resolved) {
    return undefined;
  }

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(workspaceRoot, note.source_file)),
  );
  const editor = await vscode.window.showTextDocument(document);
  const line = resolveNoteRevealLine(note, document.lineCount);
  let column: number;

  if (line === undefined) {
    return undefined;
  }

  if (note.note.anchor.type === 'Line') {
    column = Math.max((note.note.anchor.column ?? 1) - 1, 0);
  } else {
    column = Math.max((note.resolved?.column ?? 1) - 1, 0);
  }
  column = Math.min(column, document.lineAt(line).text.length);
  const position = new vscode.Position(line, column);

  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
  return { editor, line };
}

export function resolveNoteRevealLine(note: NoteView, documentLineCount: number): number | undefined {
  const oneBasedLine = note.note.anchor.type === 'Line'
    ? note.note.anchor.line ?? 1
    : note.resolved?.line;
  if (
    typeof oneBasedLine !== 'number' ||
    !Number.isInteger(oneBasedLine) ||
    oneBasedLine < 1 ||
    oneBasedLine > documentLineCount
  ) {
    return undefined;
  }
  return oneBasedLine - 1;
}
