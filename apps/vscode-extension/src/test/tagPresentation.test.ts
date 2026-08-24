import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  formatTag,
  formatTagList,
  presentTags,
} from '../features/presentation/tagPresentation';

suite('Tag presentation', () => {
  test('uses the same hash-prefixed format and ignores empty values', () => {
    assert.strictEqual(formatTag(' todo '), '#todo');
    assert.strictEqual(formatTag('#parser'), '#parser');
    assert.strictEqual(formatTagList(['todo', ' #parser ', '  ']), '#todo  #parser');
    assert.strictEqual(formatTagList([]), undefined);
  });

  test('reports tags hidden by a surface limit', () => {
    assert.deepStrictEqual(presentTags(['one', 'two', 'three'], 2), {
      tags: ['one', 'two'],
      hiddenCount: 1,
    });
    assert.strictEqual(formatTagList(['one', 'two', 'three'], 2), '#one  #two  +1 more');
  });
});
