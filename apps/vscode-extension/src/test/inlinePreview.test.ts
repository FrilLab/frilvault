import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  createInlinePreview,
  normalizeNoteForInlineDisplay,
} from '../features/presentation/inlinePreview';

suite('Note preview formatting', () => {
  test('normalizes markdown and whitespace for display', () => {
    const normalized = normalizeNoteForInlineDisplay('# Title\n\n**bold** text');

    assert.strictEqual(normalized, 'Title bold text');
  });

  test('truncates long content with a Unicode ellipsis', () => {
    const preview = createInlinePreview('abcdefghijklmnop', 8);

    assert.strictEqual(preview, 'abcdefgh…');
  });

  test('does not truncate content within length limit', () => {
    const preview = createInlinePreview('short', 10);

    assert.strictEqual(preview, 'short');
  });
});
