import * as vscode from 'vscode';

import type { InlineNoteDraft } from './draft';
import type { AutoSaveStatus } from './autoSave';

export type InlineNotePanelMessage =
  | { type: 'change'; content: string; tagsText: string }
  | { type: 'compositionStart' }
  | { type: 'compositionEnd'; content: string; tagsText: string }
  | { type: 'close' }
  | { type: 'delete' }
  | { type: 'retry' }
  | { type: 'keepLocal' }
  | { type: 'loadExternal' };

export interface InlineNotePanelLike {
  open(
    context: vscode.ExtensionContext,
    draft: InlineNoteDraft,
    onMessage: (message: InlineNotePanelMessage) => void | Promise<void>,
    onDispose?: () => void | Promise<void>,
  ): void;
  updateDraft(
    draft: InlineNoteDraft,
    options?: {
      errorMessage?: string;
      status?: AutoSaveStatus;
      canDelete?: boolean;
      replaceInputs?: boolean;
    },
  ): void;
  close(): void;
  isOpen(): boolean;
}

export class InlineNotePanel implements InlineNotePanelLike {
  private panel: vscode.WebviewPanel | undefined;
  private draft: InlineNoteDraft | undefined;
  private onMessage:
    | ((message: InlineNotePanelMessage) => void | Promise<void>)
    | undefined;
  private onDispose: (() => void | Promise<void>) | undefined;

  public open(
    context: vscode.ExtensionContext,
    draft: InlineNoteDraft,
    onMessage: (message: InlineNotePanelMessage) => void | Promise<void>,
    onDispose?: () => void | Promise<void>,
  ): void {
    this.draft = draft;
    this.onMessage = onMessage;
    this.onDispose = onDispose;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'frilvault.inlineNoteEditor',
        'Note',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [],
        },
      );

      this.panel.onDidDispose(() => {
        void this.onDispose?.();
        this.panel = undefined;
        this.draft = undefined;
        this.onMessage = undefined;
        this.onDispose = undefined;
      });

      this.panel.webview.onDidReceiveMessage(async (message: InlineNotePanelMessage) => {
        await this.onMessage?.(message);
      });

      context.subscriptions.push(this.panel);
    }

    this.panel.title = draft.mode === 'create' ? 'Add Note' : 'Edit Note';
    this.panel.webview.html = renderPanelHtml(draft);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  public updateDraft(
    draft: InlineNoteDraft,
    options?: {
      errorMessage?: string;
      status?: AutoSaveStatus;
      canDelete?: boolean;
      replaceInputs?: boolean;
    },
  ): void {
    this.draft = draft;

    if (!this.panel) {
      return;
    }

    const message: Record<string, unknown> = {
      type: 'state',
      errorMessage: options?.errorMessage,
      status: options?.status ?? 'saved',
      canDelete: options?.canDelete ?? draft.mode === 'edit',
      replaceInputs: options?.replaceInputs ?? false,
    };

    if (options?.replaceInputs) {
      message.draft = {
        content: draft.content,
        tagsText: draft.tagsText,
      };
    }

    void this.panel.webview.postMessage(message);
  }

  public close(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.draft = undefined;
    this.onMessage = undefined;
    this.onDispose = undefined;
  }

  public isOpen(): boolean {
    return this.panel !== undefined;
  }
}

function renderPanelHtml(draft: InlineNoteDraft): string {
  const nonce = String(Date.now());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Note Editor</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    body { margin: 0; padding: 16px; }
    form { display: grid; gap: 12px; max-width: 720px; }
    label { display: grid; gap: 6px; font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-weight: 400; }
    textarea, input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, #888);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font: inherit;
    }
    textarea { min-height: 220px; resize: vertical; line-height: 1.4; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button {
      padding: 6px 12px;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .error { color: var(--vscode-errorForeground); min-height: 1.2em; }
    .status { color: var(--vscode-descriptionForeground); min-height: 1.2em; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  </style>
</head>
<body>
  <form id="note-form" aria-label="note editor">
    <div>
      <strong id="mode-label">${escapeHtml(draft.mode === 'create' ? 'Create note' : 'Edit note')}</strong>
      <div class="meta" aria-label="Anchor summary">${escapeHtml(draft.anchorSummary)}</div>
      <div class="meta" aria-label="Source file">${escapeHtml(draft.sourceFile)}</div>
    </div>

    <label for="content">
      Markdown content
      <textarea id="content" name="content" aria-label="Markdown content" spellcheck="true">${escapeHtml(draft.content)}</textarea>
    </label>

    <label for="tags">
      Tags
      <input id="tags" name="tags" aria-label="Comma-separated tags" value="${escapeHtml(draft.tagsText)}" />
    </label>

    <div id="status" class="status" aria-live="polite">Editing</div>
    <div id="error" class="error" role="alert" aria-live="assertive"></div>
    <div class="hint">Changes save automatically. Use Cmd/Ctrl+Z to undo text edits.</div>

    <div class="actions">
      <button type="button" class="secondary" id="close-button" aria-label="Close editor">Close</button>
      <button type="button" class="secondary" id="delete-button" aria-label="Delete note" ${draft.mode === 'edit' ? '' : 'hidden'}>Delete</button>
      <button type="button" class="secondary" id="retry-button" aria-label="Retry save" hidden>Retry</button>
      <button type="button" class="secondary" id="keep-local-button" aria-label="Keep local version" hidden>Keep Local Version</button>
      <button type="button" class="secondary" id="load-external-button" aria-label="Load external version" hidden>Load External Version</button>
    </div>
  </form>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const contentInput = document.getElementById('content');
    const tagsInput = document.getElementById('tags');
    const errorEl = document.getElementById('error');
    const statusEl = document.getElementById('status');
    const closeButton = document.getElementById('close-button');
    const deleteButton = document.getElementById('delete-button');
    const retryButton = document.getElementById('retry-button');
    const keepLocalButton = document.getElementById('keep-local-button');
    const loadExternalButton = document.getElementById('load-external-button');

    let changeTimer;
    let isComposing = false;

    function currentPayload() {
      return { content: contentInput.value, tagsText: tagsInput.value };
    }

    function postChange() {
      const payload = currentPayload();
      vscode.postMessage({ type: 'change', ...payload });
    }

    function scheduleChange() {
      clearTimeout(changeTimer);
      statusEl.textContent = 'Editing';

      if (isComposing) {
        return;
      }

      changeTimer = setTimeout(postChange, 150);
    }

    function handleCompositionStart() {
      isComposing = true;
      clearTimeout(changeTimer);
      vscode.postMessage({ type: 'compositionStart' });
    }

    function handleCompositionEnd() {
      isComposing = false;
      const payload = currentPayload();
      vscode.postMessage({ type: 'compositionEnd', ...payload });
    }

    function flushCompositionIfNeeded() {
      if (!isComposing) {
        return;
      }

      handleCompositionEnd();
    }

    contentInput.addEventListener('input', scheduleChange);
    tagsInput.addEventListener('input', scheduleChange);
    contentInput.addEventListener('compositionstart', handleCompositionStart);
    tagsInput.addEventListener('compositionstart', handleCompositionStart);
    contentInput.addEventListener('compositionend', handleCompositionEnd);
    tagsInput.addEventListener('compositionend', handleCompositionEnd);

    closeButton.addEventListener('click', () => {
      flushCompositionIfNeeded();
      vscode.postMessage({ type: 'close' });
    });
    deleteButton.addEventListener('click', () => {
      flushCompositionIfNeeded();
      vscode.postMessage({ type: 'delete' });
    });
    retryButton.addEventListener('click', () => {
      flushCompositionIfNeeded();
      vscode.postMessage({ type: 'retry' });
    });
    keepLocalButton.addEventListener('click', () => vscode.postMessage({ type: 'keepLocal' }));
    loadExternalButton.addEventListener('click', () => vscode.postMessage({ type: 'loadExternal' }));

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'state') {
        return;
      }

      if (message.replaceInputs && message.draft) {
        contentInput.value = message.draft.content ?? contentInput.value;
        tagsInput.value = message.draft.tagsText ?? tagsInput.value;
      }

      errorEl.textContent = message.errorMessage ?? '';

      const statusLabels = {
        editing: 'Editing',
        saving: 'Saving…',
        saved: 'Saved',
        failed: 'Save failed',
        conflict: 'External change detected',
      };
      statusEl.textContent = statusLabels[message.status] ?? 'Editing';

      retryButton.hidden = message.status !== 'failed';
      keepLocalButton.hidden = message.status !== 'conflict';
      loadExternalButton.hidden = message.status !== 'conflict';
      deleteButton.hidden = !message.canDelete;
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
