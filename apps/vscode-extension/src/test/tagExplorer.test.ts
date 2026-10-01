import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test } from 'mocha';

import { COMMAND_IDS, VIEW_IDS, tagsViewActivationEvent } from '../constants/ids';
import { FrilVaultTagExplorerProvider } from '../features/tag-explorer/provider';
import {
  prepareTaggedNotes,
  prepareTagSummaries,
  tagFileIdentities,
  tagNoteDescription,
  tagNoteLabel,
} from '../features/tag-explorer/presentation';
import { TagExplorerTagItem } from '../features/tag-explorer/view';
import type { NoteView } from '../types';

suite('Tag explorer', () => {
  test('sorts tags alphabetically and removes duplicate entries', () => {
    const tags = prepareTagSummaries([
      { tag: 'todo', note_count: 2 },
      { tag: 'Architecture', note_count: 1 },
      { tag: 'TODO', note_count: 2 },
      { tag: 'performance', note_count: 3 },
    ]);

    assert.deepStrictEqual(
      tags.map((tag) => `${tag.tag}:${tag.note_count}`),
      ['Architecture:1', 'performance:3', 'todo:2'],
    );
  });

  test('shows counts and expands tags into file, anchor, and preview details', async () => {
    let tagLoads = 0;
    let noteLoads = 0;
    const symbolNote = createSymbolNote('src/parser.rs', 'parse', 'Improve error recovery', 12);
    symbolNote.resolved = { line: 12, column: 1 };
    const notes = [
      symbolNote,
      createLineNote('src/main.rs', 7, 3, 'Replace temporary initialization'),
    ];
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        return [{ tag: 'todo', note_count: 2 }];
      },
      async (tag) => {
        noteLoads += 1;
        assert.strictEqual(tag, 'todo');
        return notes;
      },
    );

    const tags = await getLoadedChildren(provider);

    assert.strictEqual(tags.length, 1);
    assert.ok(tags[0] instanceof TagExplorerTagItem);
    assert.strictEqual(tags[0].label, '#todo');
    assert.strictEqual(tags[0].description, '(2)');

    const children = await getLoadedChildren(provider, tags[0]);

    assert.deepStrictEqual(children.map((item) => item.label), [
      'L7 · main.rs · todo — Replace temporary initialization',
      'L12 · parser.rs · todo — Improve error recovery',
    ]);
    assert.strictEqual(children[0]?.description, undefined);
    assert.strictEqual(children[1]?.description, undefined);
    assert.strictEqual(children[0]?.command?.command, 'frilvault.notesPanel.openNote');

    await getLoadedChildren(provider, tags[0]);
    assert.strictEqual(tagLoads, 1);
    assert.strictEqual(noteLoads, 1);

    await provider.refresh();
    await getLoadedChildren(provider);
    assert.strictEqual(tagLoads, 2);
  });

  test('coalesces watcher invalidation with a pending same-context refresh', async () => {
    let tagLoads = 0;
    let persistedTags = [{ tag: 'existing', note_count: 1 }];
    let finishFirstLoad: ((tags: Array<{ tag: string; note_count: number }>) => void) | undefined;
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        if (tagLoads === 1) {
          return persistedTags;
        }
        if (tagLoads === 2) {
          return new Promise((resolve) => {
            finishFirstLoad = resolve;
          });
        }
        return persistedTags;
      },
      async () => [],
    );

    await getLoadedChildren(provider);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const mutationRefresh = provider.refresh();
    await Promise.resolve();
    persistedTags = [{ tag: 'latest', note_count: 2 }];
    const watcherRefresh = provider.refresh();
    await Promise.resolve();

    assert.strictEqual(tagLoads, 2, 'the watcher should join the active Tag read');
    finishFirstLoad?.([{ tag: 'outdated', note_count: 1 }]);
    await Promise.all([mutationRefresh, watcherRefresh]);
    const latestRows = await getLoadedChildren(provider);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(latestRows.map((row) => row.label), ['#latest']);
    assert.strictEqual(tagLoads, 3, 'one follow-up reads the newest Tags, then idle work settles');
  });

  test('keeps same-context rows during refresh and skips notifications for equal results', async () => {
    let tagLoads = 0;
    let finishRefresh: ((tags: Array<{ tag: string; note_count: number }>) => void) | undefined;
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        if (tagLoads === 2) {
          return new Promise((resolve) => {
            finishRefresh = resolve;
          });
        }
        return [{ tag: 'stable', note_count: 3 }];
      },
      async () => [],
    );
    await getLoadedChildren(provider);
    await new Promise<void>((resolve) => setImmediate(resolve));
    let notifications = 0;
    provider.onDidChangeTreeData(() => {
      notifications += 1;
    });

    const refresh = provider.refresh();
    await Promise.resolve();
    const duringRefresh = await provider.getChildren();

    assert.deepStrictEqual(duringRefresh.map((row) => row.label), ['#stable']);
    assert.strictEqual(notifications, 0, 'background loading should not flicker or invalidate rows');
    finishRefresh?.([{ tag: 'stable', note_count: 3 }]);
    await refresh;

    assert.strictEqual(notifications, 0, 'equal summaries should not notify the tree');
  });

  test('rapid workspace, Vault, and filter switches reject late responses', async () => {
    let context = { workspaceRoot: '/tmp/workspace', vaultRoot: '/tmp/vault', filter: 'old' };
    let finishOldLoad: ((tags: Array<{ tag: string; note_count: number }>) => void) | undefined;
    let finishMiddleLoad: ((tags: Array<{ tag: string; note_count: number }>) => void) | undefined;
    let tagLoads = 0;
    let noteLoads = 0;
    const provider = new FrilVaultTagExplorerProvider(
      async (tagContext) => {
        tagLoads += 1;
        if (tagContext.filter === 'old') {
          return new Promise((resolve) => {
            finishOldLoad = resolve;
          });
        }
        if (tagContext.filter === 'middle') {
          return new Promise((resolve) => {
            finishMiddleLoad = resolve;
          });
        }
        return [{ tag: 'new-context', note_count: 1 }];
      },
      async () => {
        noteLoads += 1;
        return [];
      },
      () => true,
      () => context,
    );

    const firstLoading = await provider.getChildren();
    assert.match(String(firstLoading[0]?.label), /loading tags/i);
    await Promise.resolve();
    context = {
      workspaceRoot: '/tmp/workspace-two',
      vaultRoot: '/tmp/vault-two',
      filter: 'middle',
    };
    const middleLoading = await provider.getChildren();
    assert.match(String(middleLoading[0]?.label), /loading tags/i);
    await Promise.resolve();
    context = {
      workspaceRoot: '/tmp/workspace-three',
      vaultRoot: '/tmp/vault-three',
      filter: 'new',
    };
    const currentRows = await getLoadedChildren(provider);
    finishOldLoad?.([{ tag: 'stale', note_count: 1 }]);
    finishMiddleLoad?.([{ tag: 'also-stale', note_count: 1 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterLateResponse = await provider.getChildren();

    assert.deepStrictEqual(currentRows.map((row) => row.label), ['#new-context']);
    assert.deepStrictEqual(afterLateResponse.map((row) => row.label), ['#new-context']);
    assert.strictEqual(tagLoads, 3);
    assert.strictEqual(noteLoads, 0);
  });

  test('disable clears Tags and prevents a late response from restoring them', async () => {
    let enabled = true;
    let finishLoad: ((tags: Array<{ tag: string; note_count: number }>) => void) | undefined;
    let tagLoads = 0;
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        return new Promise((resolve) => {
          finishLoad = resolve;
        });
      },
      async () => [],
      () => enabled,
    );

    const loading = await provider.getChildren();
    assert.match(String(loading[0]?.label), /loading tags/i);
    await Promise.resolve();
    enabled = false;
    const disabled = await provider.getChildren();
    finishLoad?.([{ tag: 'late', note_count: 1 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.match(String(disabled[0]?.label), /disabled/i);
    assert.match(String((await provider.getChildren())[0]?.label), /disabled/i);
    assert.strictEqual(tagLoads, 1);
  });

  test('external tag changes appear after refresh and failures settle until explicitly retried', async () => {
    let summaries = [{ tag: 'first', note_count: 1 }];
    let tagLoads = 0;
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        if (tagLoads === 3) {
          throw new Error('tag read failed');
        }
        return summaries;
      },
      async () => [],
    );

    const firstRows = await getLoadedChildren(provider);
    assert.deepStrictEqual(firstRows.map((row) => row.label), ['#first']);
    summaries = [{ tag: 'external', note_count: 2 }];
    await provider.refresh();
    assert.deepStrictEqual(
      (await provider.getChildren()).map((row) => row.label),
      ['#external'],
    );
    const staleTag = firstRows[0];
    assert.ok(staleTag instanceof TagExplorerTagItem);
    assert.deepStrictEqual(await provider.getChildren(staleTag), []);

    await provider.refresh();
    const failedRows = await provider.getChildren();
    assert.match(String(failedRows.at(-1)?.label), /tag read failed/i);
    await provider.getChildren();
    assert.strictEqual(tagLoads, 3, 'a settled failure must not retry on every tree read');

    await provider.refresh();
    assert.deepStrictEqual(
      (await provider.getChildren()).map((row) => row.label),
      ['#external'],
    );
    assert.strictEqual(tagLoads, 4);
  });

  test('dispose cancels pending Tag work and rejects late UI updates', async () => {
    let finishLoad: ((tags: Array<{ tag: string; note_count: number }>) => void) | undefined;
    let notifications = 0;
    const provider = new FrilVaultTagExplorerProvider(
      async () => new Promise((resolve) => {
        finishLoad = resolve;
      }),
      async () => [],
    );
    provider.onDidChangeTreeData(() => {
      notifications += 1;
    });
    await provider.getChildren();
    await Promise.resolve();
    provider.dispose();
    const notificationsAfterDispose = notifications;
    finishLoad?.([{ tag: 'late', note_count: 1 }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(await provider.getChildren(), []);
    assert.strictEqual(notifications, notificationsAfterDispose);
  });

  test('uses a theme color for configured tags and keeps uncolored tags neutral', () => {
    const colored = new TagExplorerTagItem({ tag: 'bug', note_count: 1, color: 'red' });
    const uncolored = new TagExplorerTagItem({ tag: 'todo', note_count: 1 });

    assert.strictEqual((colored.iconPath as import('vscode').ThemeIcon).color?.id, 'charts.red');
    assert.strictEqual((uncolored.iconPath as import('vscode').ThemeIcon).color, undefined);
  });

  test('supports line and symbol anchor descriptions and deterministic note ordering', () => {
    const line = createLineNote('src/b.rs', 2, 4, 'line note');
    const symbol = createSymbolNote('src/a.rs', 'run', 'symbol note', 8);
    symbol.resolved = { line: 8, column: 2 };
    const unresolved = createSymbolNote('src/a.rs', 'missing', 'unresolved note');

    assert.strictEqual(tagNoteDescription(line), 'src/b.rs · Line 2:4');
    assert.strictEqual(tagNoteDescription(symbol), 'src/a.rs · Symbol run · Line 8');
    assert.strictEqual(
      tagNoteDescription(unresolved),
      'src/a.rs · Symbol missing · Unresolved',
    );
    assert.deepStrictEqual(
      prepareTaggedNotes([line, symbol, unresolved]).map((note) => note.note.content),
      ['symbol note', 'unresolved note', 'line note'],
    );
  });

  test('puts verified locations before previews and disambiguates duplicate basenames', () => {
    const left = createLineNote('src/left/lib.rs', 16, 1, 'long body '.repeat(20));
    const right = createSymbolNote('vendor/right/lib.rs', 'parse', 'symbol body', 99);
    right.resolved = { line: 14, column: 3 };
    const identities = tagFileIdentities([left, right]);

    assert.strictEqual(identities.get('src/left/lib.rs'), 'left/lib.rs');
    assert.strictEqual(identities.get('vendor/right/lib.rs'), 'right/lib.rs');
    assert.match(
      tagNoteLabel(left, identities.get('src/left/lib.rs') ?? '', 'security'),
      /^L16 · left\/lib\.rs · security — /,
    );
    assert.match(
      tagNoteLabel(right, identities.get('vendor/right/lib.rs') ?? '', 'security'),
      /^L14 · right\/lib\.rs · security — /,
    );

    const unresolved = createSymbolNote('src/missing.rs', 'missing', 'still useful', 88);
    const unresolvedLabel = tagNoteLabel(unresolved, 'missing.rs', 'security');
    assert.match(unresolvedLabel, /^Unresolved · missing\.rs · security — still useful/);
    assert.doesNotMatch(unresolvedLabel, /L88/);
  });

  test('refreshes expanded Tag rows without reloading summaries for body-only saves', async () => {
    let tagLoads = 0;
    let noteLoads = 0;
    const updated = createLineNote('src/main.rs', 2, 1, 'before');
    const provider = new FrilVaultTagExplorerProvider(
      async () => {
        tagLoads += 1;
        return [{ tag: 'todo', note_count: 1 }];
      },
      async () => {
        noteLoads += 1;
        return [{ ...updated, note: { ...updated.note, content: noteLoads === 1 ? 'before' : 'after' } }];
      },
    );

    const tags = await getLoadedChildren(provider);
    await getLoadedChildren(provider, tags[0]);
    await provider.refreshTaggedNotes();

    assert.strictEqual(tagLoads, 1);
    assert.strictEqual(noteLoads, 2);
    const rows = await getLoadedChildren(provider, tags[0]);
    assert.match(String(rows[0]?.label), /after/);
  });

  test('shows a useful empty state when the workspace has no tagged notes', async () => {
    const provider = new FrilVaultTagExplorerProvider(
      async () => [],
      async () => [],
    );

    const children = await getLoadedChildren(provider);

    assert.strictEqual(children.length, 1);
    assert.match(String(children[0]?.label), /add tags when creating or editing a note/i);
  });

  test('package.json contributes and activates the tags view', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      activationEvents?: string[];
      contributes?: {
        views?: { explorer?: Array<{ id: string }> };
        commands?: Array<{ command: string; icon?: string }>;
        menus?: { 'view/item/context'?: Array<{ command: string; when?: string }> };
      };
    };

    assert.ok(
      packageJson.contributes?.views?.explorer?.some((view) => view.id === VIEW_IDS.tags),
    );
    assert.ok(packageJson.activationEvents?.includes(tagsViewActivationEvent()));
    for (const command of [COMMAND_IDS.setTagColor, COMMAND_IDS.removeTagColor]) {
      assert.ok(packageJson.contributes?.commands?.some((item) => item.command === command));
      assert.ok(packageJson.contributes?.menus?.['view/item/context']?.some(
        (item) => item.command === command && item.when?.includes('viewItem == frilvault.tag'),
      ));
    }
    assert.strictEqual(
      packageJson.contributes?.commands?.find((item) => item.command === COMMAND_IDS.setTagColor)?.icon,
      '$(symbol-color)',
    );
    assert.strictEqual(
      packageJson.contributes?.commands?.find((item) => item.command === COMMAND_IDS.removeTagColor)?.icon,
      '$(clear-all)',
    );
  });
});

function createLineNote(
  sourceFile: string,
  line: number,
  column: number,
  content: string,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${line}-${column}`,
      content,
      anchor: { type: 'Line', line, column },
    },
  };
}

async function getLoadedChildren(
  provider: FrilVaultTagExplorerProvider,
  element?: import('../features/tag-explorer/view').TagExplorerTreeNode,
): Promise<import('../features/tag-explorer/view').TagExplorerTreeNode[]> {
  while (true) {
    let disposeListener = () => undefined;
    const changed = new Promise<void>((resolve) => {
      const listener = provider.onDidChangeTreeData(() => {
        disposeListener();
        resolve();
      });
      disposeListener = () => listener.dispose();
    });
    const children = await provider.getChildren(element);
    if (!children.some((child) => /^Loading /.test(String(child.label)))) {
      disposeListener();
      return children;
    }
    await changed;
  }
}

function createSymbolNote(
  sourceFile: string,
  name: string,
  content: string,
  lineHint?: number,
): NoteView {
  return {
    source_file: sourceFile,
    note: {
      id: `${sourceFile}-${name}`,
      content,
      anchor: {
        type: 'Symbol',
        name,
        kind: 'Function',
        line_hint: lineHint,
      },
    },
  };
}
