import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { suite, test } from 'mocha';
import * as vscode from 'vscode';

import { CliClient, type UpdateNoteInput } from '../core/cliClient';
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

    await editor.openEdit(createLineNoteView('note'));
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

    await editor.openEdit(createLineNoteView('te'));

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

    await editor.openEdit(createLineNoteView('a'));

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

    await editor.openEdit(createLineNoteView(''));

    await panel.emit({ type: 'compositionStart' });
    await panel.emit({ type: 'change', content: 'ㅌ', tagsText: '' });
    await panel.emit({ type: 'retry' });

    assert.deepStrictEqual(savedContents, []);

    await panel.emit({ type: 'compositionEnd', content: '테', tagsText: '' });
    await panel.emit({ type: 'retry' });

    assert.deepStrictEqual(savedContents, ['테']);
    assert.strictEqual(panel.latestStatus(), 'saved');
  });

  test('native close settles an in-flight save before reopening the persisted note', async () => {
    const panel = new FakeInlineNotePanel();
    let persisted = createLineNoteView('before close');
    let saveCount = 0;
    const editor = createTestEditor({
      cliClient: {
        tagList: async () => [],
        listNotes: async () => [persisted],
        updateNote: async (input: UpdateNoteInput) => {
          saveCount += 1;
          persisted = createSavedLineNoteView(input.content, '2026-09-30T00:00:01Z');
          return persisted;
        },
      } as unknown as CliClient,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(60_000, onStatusChange, persist),
    });

    await editor.openEdit(persisted);
    await panel.emit({ type: 'change', content: 'latest typed characters', tagsText: '' });

    panel.disposeNatively();
    await editor.openEdit(createLineNoteView('before close'));
    await waitFor(() => panel.openCount === 2);

    assert.strictEqual(saveCount, 1);
    assert.strictEqual(persisted.note.content, 'latest typed characters');
    assert.strictEqual(panel.openedDraft?.content, 'latest typed characters');
    editor.dispose();
  });

  test('immediate native close persists and reopens through the CLI boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frilvault-note-close-test-'));
    const cliPath = path.join(root, 'fake-flvt');
    const statePath = path.join(root, '.frilvault-state.json');
    const initialNote = createLineNoteView('before close');
    fs.writeFileSync(statePath, JSON.stringify({ notes: [initialNote] }));
    fs.writeFileSync(
      cliPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = args[0];
const statePath = path.join(process.cwd(), '.frilvault-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const value = (flag) => args[args.indexOf(flag) + 1];
if (command === '--version') { process.stdout.write('flvt 0.1.0'); process.exit(0); }
if (command === 'tag') { process.stdout.write('[]'); process.exit(0); }
if (command === 'list') {
  process.stdout.write(JSON.stringify(state.notes.filter((item) => item.source_file === value('--file'))));
  process.exit(0);
}
if (command === 'update') {
  const note = state.notes.find((item) => item.note.id === value('--id'));
  if (!note) { process.stderr.write('note not found'); process.exit(1); }
  note.note.content = value('--content');
  note.note.updated_at = '2026-09-30T00:00:03Z';
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify(note));
  process.exit(0);
}
process.stderr.write('unsupported command');
process.exit(1);
`,
      { mode: 0o755 },
    );

    const panel = new FakeInlineNotePanel();
    const cliClient = new CliClient({
      getConfiguredCliPath: () => cliPath,
      extensionVersion: '0.1.0',
    });
    const editor = createTestEditor({
      cliClient,
      getWorkspaceRoot: () => root,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(60_000, onStatusChange, persist),
    });

    try {
      await editor.openEdit(initialNote);
      await panel.emit({ type: 'change', content: 'last persisted characters', tagsText: '' });
      panel.disposeNatively();
      await editor.openEdit(initialNote);
      await waitFor(() => panel.openCount === 2, 5_000);

      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { notes: NoteView[] };
      assert.strictEqual(persisted.notes[0]?.note.content, 'last persisted characters');
      assert.strictEqual(panel.openedDraft?.content, 'last persisted characters');
    } finally {
      editor.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('native close recovers the latest received input after save failure', async () => {
    const panel = new FakeInlineNotePanel();
    const state = createMockMemento();
    let saveCount = 0;
    const editor = createTestEditor({
      cliClient: {
        tagList: async () => [],
        listNotes: async () => [createLineNoteView('before close')],
        updateNote: async () => {
          saveCount += 1;
          throw new Error('vault is unavailable');
        },
      } as unknown as CliClient,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(60_000, onStatusChange, persist),
    }, state);

    await editor.openEdit(createLineNoteView('before close'));
    await panel.emit({ type: 'change', content: 'last characters typed', tagsText: '#keep' });

    panel.disposeNatively();
    await editor.openEdit(createLineNoteView('before close'));
    await waitFor(() => panel.openCount === 2);

    assert.strictEqual(saveCount, 1);
    assert.strictEqual(panel.openedDraft?.content, 'last characters typed');
    assert.strictEqual(panel.openedDraft?.tagsText, '#keep');
    assert.strictEqual(panel.latestStatus(), 'editing');
    editor.dispose();
  });

  test('a failed extension-controlled close keeps the editor open and actionable', async () => {
    const panel = new FakeInlineNotePanel();
    const editor = createTestEditor({
      cliClient: {
        tagList: async () => [],
        updateNote: async () => {
          throw new Error('vault is unavailable');
        },
      } as unknown as CliClient,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(60_000, onStatusChange, persist),
    });

    await editor.openEdit(createLineNoteView('before close'));
    await panel.emit({ type: 'change', content: 'unsaved draft', tagsText: '' });
    await panel.emit({ type: 'close' });

    assert.strictEqual(panel.isOpen(), true);
    assert.strictEqual(panel.latestStatus(), 'failed');
    assert.match(panel.latestError() ?? '', /Save failed/);
    editor.dispose();
  });

  test('a refresh failure after persistence does not retry the save', async () => {
    const panel = new FakeInlineNotePanel();
    let saveCount = 0;
    const warnings: string[] = [];
    const editor = createTestEditor({
      cliClient: {
        tagList: async () => [],
        updateNote: async (input: UpdateNoteInput) => {
          saveCount += 1;
          return createSavedLineNoteView(input.content, '2026-09-30T00:00:02Z');
        },
      } as unknown as CliClient,
      panel,
      refreshNoteState: async () => {
        throw new Error('view reload failed');
      },
      showWarningMessage: async (message) => {
        warnings.push(message);
        return undefined;
      },
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(60_000, onStatusChange, persist),
    });

    await editor.openEdit(createLineNoteView('before refresh'));
    await panel.emit({ type: 'change', content: 'persisted once', tagsText: '' });
    await panel.emit({ type: 'retry' });

    assert.strictEqual(saveCount, 1);
    assert.strictEqual(panel.latestStatus(), 'saved');
    assert.ok(warnings.some((warning) => warning.includes('note saved')));
    editor.dispose();
  });

  test('disable pauses autosave while retaining a draft that resumes later', async () => {
    const panel = new FakeInlineNotePanel();
    const savedContents: string[] = [];
    const editor = createTestEditor({
      cliClient: {
        tagList: async () => [],
        updateNote: async (input: UpdateNoteInput) => {
          savedContents.push(input.content);
          return createSavedLineNoteView(input.content, '2026-09-30T00:00:04Z');
        },
      } as unknown as CliClient,
      panel,
      createAutoSave: (onStatusChange, persist) =>
        new DebouncedAutoSave(60_000, onStatusChange, persist),
    });

    await editor.openEdit(createLineNoteView('before disable'));
    editor.suspend();
    await panel.emit({ type: 'change', content: 'typed while disabled', tagsText: '' });

    assert.deepStrictEqual(savedContents, []);
    assert.match(panel.latestError() ?? '', /FrilVault is disabled/);

    editor.resume();
    await panel.emit({ type: 'retry' });

    assert.deepStrictEqual(savedContents, ['typed while disabled']);
    assert.strictEqual(panel.latestStatus(), 'saved');
    editor.dispose();
  });
});

class FakeInlineNotePanel implements InlineNotePanelLike {
  public tagSuggestions: string[] = [];
  public openCount = 0;
  public openedDraft: InlineNoteDraft | undefined;
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
  private onDispose: (() => void | Promise<void>) | undefined;

  public open(
    _context: vscode.ExtensionContext,
    draft: InlineNoteDraft,
    onMessage: (message: InlineNotePanelMessage) => void | Promise<void>,
    onDispose?: () => void | Promise<void>,
  ): void {
    this.openCount += 1;
    this.openedDraft = draft;
    this.onMessage = onMessage;
    this.onDispose = onDispose;
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
    this.onDispose = undefined;
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

  public disposeNatively(): void {
    const onDispose = this.onDispose;
    this.onMessage = undefined;
    this.onDispose = undefined;
    void onDispose?.();
  }

  public latestStatus(): AutoSaveStatus | undefined {
    return this.updates.at(-1)?.options?.status;
  }

  public latestError(): string | undefined {
    return this.updates.at(-1)?.options?.errorMessage;
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
  workspaceState: vscode.Memento = createMockMemento(),
) {
  const editor = createInlineNoteEditor({
    cliClient: { tagList: async () => [] } as unknown as CliClient,
    getWorkspaceRoot: () => '/tmp/workspace',
    refreshNoteState: async () => undefined,
    ...overrides,
  });

  editor.register({ subscriptions: [], workspaceState } as unknown as vscode.ExtensionContext);
  return editor;
}

function createMockMemento(): vscode.Memento {
  const storage = new Map<string, unknown>();

  return {
    keys: () => [...storage.keys()],
    get: <T>(key: string) => storage.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      storage.set(key, value);
    },
  };
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
