import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import {
  formatTag,
  formatTagList,
  presentTags,
} from '../features/presentation/tagPresentation';
import { prepareTagSummaries } from '../features/tag-explorer/presentation';
import { TagExplorerTagItem } from '../features/tag-explorer/view';

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

  test('keeps configured colors attached to the Tag rows', () => {
    const summaries = prepareTagSummaries([
      { tag: 'Bug', note_count: 1, color: 'red' },
      { tag: 'todo', note_count: 1 },
    ]);
    const bug = new TagExplorerTagItem(summaries[0]!);
    const todo = new TagExplorerTagItem(summaries[1]!);

    assert.strictEqual((bug.iconPath as import('vscode').ThemeIcon).color?.id, 'charts.red');
    assert.strictEqual((todo.iconPath as import('vscode').ThemeIcon).color, undefined);
  });

});
