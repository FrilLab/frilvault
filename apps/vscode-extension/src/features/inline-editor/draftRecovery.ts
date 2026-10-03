import * as path from 'node:path';

import type * as vscode from 'vscode';

import type { InlineNoteDraft } from './draft';

const RECOVERY_STATE_KEY = 'frilvault.inlineNoteDrafts';

export interface RecoveredInlineNoteDraft {
  id: string;
  sessionId: string;
  revision: number;
  draft: InlineNoteDraft;
}

type RecoveryState = Record<string, RecoveredInlineNoteDraft>;

/**
 * Stores received editor drafts in VS Code workspace state so native webview
 * disposal cannot discard input while an asynchronous CLI save is in flight.
 */
export class InlineNoteDraftRecoveryStore {
  private pendingWrite: Promise<void> = Promise.resolve();

  public constructor(private readonly state: vscode.Memento) {}

  public get(draft: InlineNoteDraft): RecoveredInlineNoteDraft | undefined {
    const state = this.readState();
    const identity = recoveryId(draft);
    // A create session keeps its original storage key after its first save.
    // The saved draft metadata now identifies a note, so also follow that identity.
    const scoped = state[identity] ?? Object.values(state)
      .find((entry) => recoveryId(entry.draft) === identity);
    if (scoped) {
      return scoped;
    }
    // Keep pre-Vault-scoping drafts recoverable; a revision mismatch is handled
    // as a conflict by the editor, and recovery is pinned to the chosen Vault.
    const legacyIdentity = legacyRecoveryId(draft);
    const legacy = state[legacyIdentity] ?? Object.values(state)
      .find((entry) => !entry.draft.vaultPath && legacyRecoveryId(entry.draft) === legacyIdentity);
    return legacy?.draft.vaultPath && legacy.draft.vaultPath !== draft.vaultPath
      ? undefined : legacy;
  }

  public write(
    id: string,
    sessionId: string,
    revision: number,
    draft: InlineNoteDraft,
  ): Promise<void> {
    return this.enqueue(async () => {
      const state = this.readState();
      const previous = state[id];

      if (
        previous?.sessionId === sessionId &&
        previous.revision > revision
      ) {
        return;
      }

      state[id] = { id, sessionId, revision, draft };
      await this.state.update(RECOVERY_STATE_KEY, state);
    });
  }

  public clear(id: string, sessionId: string, throughRevision: number): Promise<void> {
    return this.enqueue(async () => {
      const state = this.readState();
      const previous = state[id];

      if (
        previous?.sessionId !== sessionId ||
        previous.revision > throughRevision
      ) {
        return;
      }

      delete state[id];
      await this.state.update(RECOVERY_STATE_KEY, state);
    });
  }

  private readState(): RecoveryState {
    return this.state.get<RecoveryState>(RECOVERY_STATE_KEY) ?? {};
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pendingWrite.then(operation);
    this.pendingWrite = result.catch(() => undefined);
    return result;
  }
}

export function recoveryId(draft: InlineNoteDraft): string {
  const identity = draft.noteId
    ? ['note', draft.noteId]
    : [
        'create',
        draft.kind,
        draft.line,
        draft.column,
        draft.symbolName,
        draft.symbolKind,
        draft.symbolSignature,
      ];

  return JSON.stringify([
    path.resolve(draft.workspaceRoot),
    draft.vaultPath ?? null,
    draft.sourceFile,
    ...identity,
  ]);
}

function legacyRecoveryId(draft: InlineNoteDraft): string {
  const identity = draft.noteId ? ['note', draft.noteId] : [
    'create', draft.kind, draft.line, draft.column, draft.symbolName, draft.symbolKind,
  ];
  return JSON.stringify([path.resolve(draft.workspaceRoot), draft.sourceFile, ...identity]);
}
