import * as assert from 'node:assert';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import type { CliClient, UpdateNoteInput } from '../core/cliClient';
import {
  type AutoSaveController,
  type AutoSaveStatus,
  DebouncedAutoSave,
} from '../features/inline-editor/autoSave';
import {
  createInlineNoteEditor,
  type InlineNoteEditorDependencies,
} from '../features/inline-editor/editor';
import type { InlineNoteDraft } from '../features/inline-editor/draft';
import {
  type InlineNotePanelLike,
  type InlineNotePanelMessage,
} from '../features/inline-editor/panel';
import type { NoteView } from '../types';

suite('Inline note editor race handling', () => {
  test('loads current workspace tags when the editor opens', async () => {
    const panel = new FakeInlineNotePanel();
    const editor = createTestEditor({
      cliClient: {
        tagList: async () => [
          { tag: 'performance', note_count: 2 },
          { tag: 'permission', note_count: 1 },
        ],
      } as unknown as CliClient,
      panel,
    });

    editor.openEdit(createLineNoteView('note'));
    await waitFor(() => panel.tagSuggestions.length === 2);

    assert.deepStrictEqual(panel.tagSuggestions, ['performance', 'permission']);
  });

  test('rapid typing persists the latest draft without replacing active input state', async () => {
    const panel = new FakeInlineNotePanel();
    const firstSave = deferred<NoteView>();
    const secondSave = deferred<NoteView>();
    const savedContents: string[] = [];

    const cliClient = {
      tagList: async () => [],
      updateNote: async (input: UpdateNoteInput) => {
        savedContents.push(input.content);

        return savedContents.length === 1 ? firstSave.promise : secondSave.promise;
      },
    } as unknown as CliClient;

    const editor = createTestEditor({
      cliClient,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(0, onStatusChange, persist),
    });

    editor.openEdit(createLineNoteView('te'));

    await panel.emit({ type: 'change', content: 'tes', tagsText: '' });
    const flush = panel.emit({ type: 'retry' });

    await waitFor(() => savedContents.length === 1);
    await panel.emit({ type: 'change', content: 'test', tagsText: '' });

    firstSave.resolve(createSavedLineNoteView('tes', '2026-07-23T00:00:01Z'));
    await waitFor(() => savedContents.length === 2);

    secondSave.resolve(createSavedLineNoteView('test', '2026-07-23T00:00:02Z'));
    await flush;

    assert.deepStrictEqual(savedContents, ['tes', 'test']);
    assert.strictEqual(
      panel.updates.some((update) => update.options?.replaceInputs === true),
      false,
    );
    assert.strictEqual(panel.latestStatus(), 'saved');
  });

  test('stale save completions cannot overwrite a newer persisted revision', async () => {
    const panel = new FakeInlineNotePanel();
    const persistCalls: string[] = [];
    const autoSave = new ManualAutoSaveController();

    const cliClient = {
      tagList: async () => [],
      updateNote: async (input: UpdateNoteInput) => {
        persistCalls.push(input.content);
        return createSavedLineNoteView(input.content, '2026-07-23T00:00:03Z');
      },
    } as unknown as CliClient;

    const editor = createTestEditor({
      cliClient,
      panel,
      createAutoSave: (onStatusChange, persist) => autoSave.bind(onStatusChange, persist),
    });

    editor.openEdit(createLineNoteView('a'));

    await panel.emit({ type: 'change', content: 'ab', tagsText: '' });
    await panel.emit({ type: 'change', content: 'abc', tagsText: '' });

    await autoSave.persistRevision(2);
    await autoSave.persistRevision(1);

    assert.deepStrictEqual(persistCalls, ['abc']);
    assert.strictEqual(panel.latestStatus(), 'saved');
  });

  test('IME composition is not persisted until composition completes', async () => {
    const panel = new FakeInlineNotePanel();
    const savedContents: string[] = [];

    const cliClient = {
      tagList: async () => [],
      updateNote: async (input: UpdateNoteInput) => {
        savedContents.push(input.content);
        return createSavedLineNoteView(input.content, '2026-07-23T00:00:04Z');
      },
    } as unknown as CliClient;

    const editor = createTestEditor({
      cliClient,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(0, onStatusChange, persist),
    });

    editor.openEdit(createLineNoteView(''));

    await panel.emit({ type: 'compositionStart' });
    await panel.emit({ type: 'change', content: 'ㅌ', tagsText: '' });
    await panel.emit({ type: 'retry' });

    assert.deepStrictEqual(savedContents, []);

    await panel.emit({ type: 'compositionEnd', content: '테', tagsText: '' });
    await panel.emit({ type: 'retry' });

    assert.deepStrictEqual(savedContents, ['테']);
    assert.strictEqual(panel.latestStatus(), 'saved');
  });
});

class FakeInlineNotePanel implements InlineNotePanelLike {
  public tagSuggestions: string[] = [];
  public readonly updates: Array<{
    draft: { content: string; tagsText: string };
    options?: {
      errorMessage?: string;
      status?: AutoSaveStatus;
      canDelete?: boolean;
      replaceInputs?: boolean;
    };
  }> = [];

  private onMessage:
    | ((message: InlineNotePanelMessage) => void | Promise<void>)
    | undefined;

  public open(
    _context: vscode.ExtensionContext,
    _draft: InlineNoteDraft,
    onMessage: (message: InlineNotePanelMessage) => void | Promise<void>,
  ): void {
    this.onMessage = onMessage;
  }

  public updateDraft(
    draft: { content: string; tagsText: string },
    options?: {
      errorMessage?: string;
      status?: AutoSaveStatus;
      canDelete?: boolean;
      replaceInputs?: boolean;
    },
  ): void {
    this.updates.push({
      draft: { content: draft.content, tagsText: draft.tagsText },
      options,
    });
  }

  public close(): void {
    this.onMessage = undefined;
  }

  public updateTagSuggestions(tags: string[]): void {
    this.tagSuggestions = tags;
  }

  public isOpen(): boolean {
    return this.onMessage !== undefined;
  }

  public async emit(message: InlineNotePanelMessage): Promise<void> {
    await this.onMessage?.(message);
  }

  public latestStatus(): AutoSaveStatus | undefined {
    return this.updates.at(-1)?.options?.status;
  }
}

class ManualAutoSaveController implements AutoSaveController {
  private persist:
    | ((revision: number) => Promise<void>)
    | undefined;

  public bind(
    onStatusChange: (status: AutoSaveStatus) => void,
    persist: (revision: number) => Promise<void>,
  ): AutoSaveController {
    this.persist = async (revision: number) => {
      onStatusChange('saving');
      await persist(revision);
      onStatusChange('saved');
    };

    return this;
  }

  public reset(): void {}

  public schedule(): void {}

  public async flush(): Promise<void> {}

  public cancel(): void {}

  public startComposition(): void {}

  public endComposition(): void {}

  public async persistRevision(revision: number): Promise<void> {
    await this.persist?.(revision);
  }
}

function createTestEditor(
  overrides: Partial<InlineNoteEditorDependencies>,
) {
  const editor = createInlineNoteEditor({
    cliClient: { tagList: async () => [] } as unknown as CliClient,
    getWorkspaceRoot: () => '/tmp/workspace',
    refreshNoteState: async () => undefined,
    ...overrides,
  });

  editor.register({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  return editor;
}

function createLineNoteView(content: string): NoteView {
  return {
    source_file: 'src/main.ts',
    note: {
      id: 'note-id',
      content,
      tags: [],
      updated_at: '2026-07-23T00:00:00Z',
      anchor: { type: 'Line', line: 2, column: 1 },
    },
  };
}

function createSavedLineNoteView(content: string, updatedAt: string): NoteView {
  return {
    source_file: 'src/main.ts',
    note: {
      id: 'note-id',
      content,
      tags: [],
      updated_at: updatedAt,
      anchor: { type: 'Line', line: 2, column: 1 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
