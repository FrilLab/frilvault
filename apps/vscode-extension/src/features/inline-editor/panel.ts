import * as vscode from 'vscode';

import type { InlineNoteDraft } from './draft';
import type { AutoSaveStatus } from './autoSave';

export type InlineNotePanelMessage =
  | { type: 'change'; content: string; tagsText: string }
  | { type: 'compositionStart' }
  | { type: 'compositionEnd'; content: string; tagsText: string }
  | { type: 'requestTagSuggestions' }
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
  updateTagSuggestions?(tags: string[]): void;
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

  public updateTagSuggestions(tags: string[]): void {
    void this.panel?.webview.postMessage({ type: 'tagSuggestions', tags });
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
    .tag-field { position: relative; }
    .tag-suggestions {
      position: absolute;
      z-index: 1;
      top: 100%;
      right: 0;
      left: 0;
      max-height: 180px;
      margin: 2px 0 0;
      padding: 4px 0;
      overflow-y: auto;
      border: 1px solid var(--vscode-dropdown-border, #888);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border-radius: 4px;
      list-style: none;
    }
    .tag-suggestions[hidden] { display: none; }
    .tag-suggestion { padding: 6px 8px; cursor: pointer; }
    .tag-suggestion.active,
    .tag-suggestion:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
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

    <div class="tag-field">
      <label for="tags">
        Tags
        <input id="tags" name="tags" role="combobox" aria-label="Comma-separated tags" aria-autocomplete="list" aria-controls="tag-suggestions" aria-expanded="false" value="${escapeHtml(draft.tagsText)}" />
      </label>
      <ul id="tag-suggestions" class="tag-suggestions" role="listbox" hidden></ul>
    </div>

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
    const form = document.getElementById('note-form');
    const contentInput = document.getElementById('content');
    const tagsInput = document.getElementById('tags');
    const tagSuggestionsEl = document.getElementById('tag-suggestions');
    const errorEl = document.getElementById('error');
    const statusEl = document.getElementById('status');
    const closeButton = document.getElementById('close-button');
    const deleteButton = document.getElementById('delete-button');
    const retryButton = document.getElementById('retry-button');
    const keepLocalButton = document.getElementById('keep-local-button');
    const loadExternalButton = document.getElementById('load-external-button');

    let changeTimer;
    let isComposing = false;
    let tagSuggestions = [];
    let filteredTagSuggestions = [];
    let activeTagSuggestion = -1;

    function selectedTagKeys() {
      const parts = tagsInput.value.split(',');
      parts.pop();
      return new Set(parts.map((tag) => normalizeTag(tag).toLowerCase()).filter(Boolean));
    }

    function normalizeTag(tag) {
      const trimmed = tag.trim();
      return (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).trim();
    }

    function activeTagQuery() {
      return normalizeTag(tagsInput.value.split(',').at(-1) ?? '').toLowerCase();
    }

    function hideTagSuggestions() {
      filteredTagSuggestions = [];
      activeTagSuggestion = -1;
      tagSuggestionsEl.hidden = true;
      tagsInput.setAttribute('aria-expanded', 'false');
      tagsInput.removeAttribute('aria-activedescendant');
    }

    function renderTagSuggestions() {
      const query = activeTagQuery();
      const selected = selectedTagKeys();
      filteredTagSuggestions = tagSuggestions.filter((tag) =>
        !selected.has(tag.toLowerCase()) && tag.toLowerCase().includes(query)
      );

      tagSuggestionsEl.replaceChildren();
      if (filteredTagSuggestions.length === 0) {
        hideTagSuggestions();
        return;
      }

      activeTagSuggestion = Math.min(activeTagSuggestion, filteredTagSuggestions.length - 1);
      filteredTagSuggestions.forEach((tag, index) => {
        const option = document.createElement('li');
        option.id = 'tag-suggestion-' + index;
        option.className = 'tag-suggestion' + (index === activeTagSuggestion ? ' active' : '');
        option.role = 'option';
        option.setAttribute('aria-selected', String(index === activeTagSuggestion));
        option.textContent = '#' + tag;
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          selectTagSuggestion(index);
        });
        tagSuggestionsEl.append(option);
      });

      tagSuggestionsEl.hidden = false;
      tagsInput.setAttribute('aria-expanded', 'true');
      if (activeTagSuggestion >= 0) {
        tagsInput.setAttribute('aria-activedescendant', 'tag-suggestion-' + activeTagSuggestion);
      } else {
        tagsInput.removeAttribute('aria-activedescendant');
      }
    }

    function selectTagSuggestion(index) {
      const selected = filteredTagSuggestions[index];
      if (!selected) {
        return;
      }

      const parts = tagsInput.value.split(',');
      parts[parts.length - 1] = '#' + selected;
      tagsInput.value = parts.map((part) => part.trim()).filter(Boolean).join(', ') + ', ';
      hideTagSuggestions();
      scheduleChange();
      tagsInput.focus();
    }

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
    tagsInput.addEventListener('input', () => {
      activeTagSuggestion = -1;
      renderTagSuggestions();
      scheduleChange();
    });
    form.addEventListener('submit', (event) => event.preventDefault());
    tagsInput.addEventListener('focus', () => {
      vscode.postMessage({ type: 'requestTagSuggestions' });
      renderTagSuggestions();
    });
    tagsInput.addEventListener('blur', () => setTimeout(hideTagSuggestions, 100));
    tagsInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideTagSuggestions();
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (tagSuggestionsEl.hidden) {
          renderTagSuggestions();
        }
        if (filteredTagSuggestions.length > 0) {
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          activeTagSuggestion = activeTagSuggestion < 0
            ? (direction > 0 ? 0 : filteredTagSuggestions.length - 1)
            : (activeTagSuggestion + direction + filteredTagSuggestions.length) % filteredTagSuggestions.length;
          renderTagSuggestions();
        }
        return;
      }

      if ((event.key === 'Enter' || event.key === 'Tab') && activeTagSuggestion >= 0) {
        event.preventDefault();
        selectTagSuggestion(activeTagSuggestion);
      }
    });
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
        if (message?.type === 'tagSuggestions' && Array.isArray(message.tags)) {
          const seen = new Set();
          tagSuggestions = message.tags.filter((tag) => {
            const key = tag.toLowerCase();
            if (tag.length === 0 || seen.has(key)) {
              return false;
            }
            seen.add(key);
            return true;
          });
          if (document.activeElement === tagsInput) {
            renderTagSuggestions();
          }
        }
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
