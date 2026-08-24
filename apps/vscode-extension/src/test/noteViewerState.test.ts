import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { NoteViewerState } from '../features/note-viewer/noteViewerState';

suite('Note viewer state', () => {
  test('returns default value when no state is set', () => {
    const state = new NoteViewerState();

    assert.strictEqual(state.isCollapsed('doc1', 'note1', true), true);
    assert.strictEqual(state.isCollapsed('doc1', 'note1', false), false);
  });

  test('toggle changes the collapsed state', () => {
    const state = new NoteViewerState();

    state.toggle('doc1', 'note1', true);
    assert.strictEqual(state.isCollapsed('doc1', 'note1', true), false);
  });

  test('toggle twice restores original state', () => {
    const state = new NoteViewerState();

    state.toggle('doc1', 'note1', true);
    state.toggle('doc1', 'note1', false);
    assert.strictEqual(state.isCollapsed('doc1', 'note1', true), true);
  });

  test('clearDocument removes state for specific document', () => {
    const state = new NoteViewerState();

    state.toggle('doc1', 'note1', true);
    state.toggle('doc2', 'note2', true);
    state.clearDocument('doc1');

    assert.strictEqual(state.isCollapsed('doc1', 'note1', true), true);
    assert.strictEqual(state.isCollapsed('doc2', 'note2', true), false);
  });

  test('clear removes all state', () => {
    const state = new NoteViewerState();

    state.toggle('doc1', 'note1', true);
    state.toggle('doc2', 'note2', true);
    state.clear();

    assert.strictEqual(state.isCollapsed('doc1', 'note1', true), true);
    assert.strictEqual(state.isCollapsed('doc2', 'note2', true), true);
  });

  test('different documents have independent state', () => {
    const state = new NoteViewerState();

    state.toggle('doc1', 'note1', true);

    assert.strictEqual(state.isCollapsed('doc1', 'note1', true), false);
    assert.strictEqual(state.isCollapsed('doc2', 'note1', true), true);
  });
});
