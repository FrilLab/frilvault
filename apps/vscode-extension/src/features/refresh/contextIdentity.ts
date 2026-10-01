import * as fs from 'node:fs';
import * as path from 'node:path';

export function workspaceVaultContextKey(workspaceRoot: string, vaultRoot: string): string {
  return JSON.stringify([
    canonicalPath(workspaceRoot),
    canonicalPath(vaultRoot),
  ]);
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
