import * as vscode from 'vscode';
import * as path from 'node:path';

import { getRelativeFilePath, getVaultRoot, getWorkspaceRootForSource } from '../../utils/file';

export function isEligibleSourceEditor(
  editor: vscode.TextEditor | undefined,
  isEnabled: (root: string) => boolean,
): boolean {
  if (!editor || editor.document.uri.scheme !== 'file') {
    return false;
  }
  try {
    const root = getWorkspaceRootForSource(editor.document.uri);
    getRelativeFilePath(root, editor.document.uri.fsPath);
    const relativeToVault = path.relative(getVaultRoot(root), editor.document.uri.fsPath);
    return isEnabled(root) && relativeToVault !== '' &&
      (relativeToVault.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToVault));
  } catch {
    return false;
  }
}
