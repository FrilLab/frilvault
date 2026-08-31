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

export function getVaultRoot(workspaceRoot: string): string {
  const configured = tryGetVaultPath();

  if (configured) {
    return path.resolve(workspaceRoot, configured);
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
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

export async function revealNote(note: NoteView, workspaceRoot: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(workspaceRoot, note.source_file)),
  );
  const editor = await vscode.window.showTextDocument(document);
  let line: number;
  let column: number;

  if (note.note.anchor.type === 'Line') {
    line = Math.max((note.note.anchor.line ?? 1) - 1, 0);
    column = Math.max((note.note.anchor.column ?? 1) - 1, 0);
  } else if (note.resolved) {
    line = Math.max(note.resolved.line - 1, 0);
    column = Math.max(note.resolved.column - 1, 0);
  } else {
    line = Math.max((note.note.anchor.line_hint ?? 1) - 1, 0);
    column = 0;
  }
  const position = new vscode.Position(line, column);

  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}
