import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { NoteViewerState } from '../features/note-viewer/state';

suite('Note viewer state', () => {
  test('tracks explicit expansion for collapsed defaults', () => {
    const state = new NoteViewerState();

    assert.strictEqual(state.isExpanded('file:///a.ts', 'group-1', 'collapsed'), false);

    state.toggle('file:///a.ts', 'group-1', 'collapsed');

    assert.strictEqual(state.isExpanded('file:///a.ts', 'group-1', 'collapsed'), true);
  });

  test('tracks explicit collapse for expanded defaults', () => {
    const state = new NoteViewerState();

    assert.strictEqual(state.isExpanded('file:///a.ts', 'group-1', 'expanded'), true);

    state.toggle('file:///a.ts', 'group-1', 'expanded');

    assert.strictEqual(state.isExpanded('file:///a.ts', 'group-1', 'expanded'), false);
  });

  test('cleans up closed editors', () => {
    const state = new NoteViewerState();
    state.toggle('file:///a.ts', 'group-1', 'collapsed');

    state.retainVisibleEditors([]);

    assert.strictEqual(state.isExpanded('file:///a.ts', 'group-1', 'collapsed'), false);
  });
});
