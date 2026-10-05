import * as vscode from 'vscode';

export interface RefreshTraceEvent {
  component: string;
  event: string;
  requestId?: number;
  contextId?: string;
  contextGeneration?: number;
  invalidationGeneration?: number;
  attempt?: number;
  trigger?: string;
  outcome?: string;
  durationMs?: number;
}

export type RefreshTraceSink = (event: RefreshTraceEvent) => void;

/** Returns a stable opaque identifier; paths and vault names stay out of logs. */
export function refreshContextId(contextKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < contextKey.length; index += 1) {
    hash ^= contextKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ctx-${(hash >>> 0).toString(36)}`;
}

/** Metadata-only diagnostics are disabled unless explicitly enabled by the user. */
export function createRefreshDiagnosticLogger(
  output: vscode.OutputChannel,
): RefreshTraceSink {
  return (event) => {
    if (!vscode.workspace.getConfiguration('frilvault')
      .get<boolean>('refreshDiagnostics.enabled', false)) {
      return;
    }

    const fields = [
      `component=${safeToken(event.component)}`,
      `event=${safeToken(event.event)}`,
      event.requestId === undefined ? undefined : `request=${event.requestId}`,
      event.contextId ? `context=${safeToken(event.contextId)}` : undefined,
      event.contextGeneration === undefined ? undefined : `contextGeneration=${event.contextGeneration}`,
      event.invalidationGeneration === undefined ? undefined : `invalidationGeneration=${event.invalidationGeneration}`,
      event.attempt === undefined ? undefined : `attempt=${event.attempt}`,
      event.trigger ? `trigger=${safeToken(event.trigger)}` : undefined,
      event.outcome ? `outcome=${safeToken(event.outcome)}` : undefined,
      event.durationMs === undefined ? undefined : `durationMs=${event.durationMs}`,
    ].filter((field): field is string => field !== undefined);
    output.appendLine(`[refresh] ${fields.join(' ')}`);
  };
}

function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}
