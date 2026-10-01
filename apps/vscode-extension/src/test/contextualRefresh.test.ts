import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { ContextualRefresh } from '../features/refresh/contextualRefresh';

suite('Contextual refresh', () => {
  test('coalesces an in-flight invalidation and bounds repeated feedback', async () => {
    const refresh = new ContextualRefresh<number>();
    let loads = 0;
    let finishFirst: ((value: number) => void) | undefined;
    const values: number[] = [];
    const load = async (): Promise<number> => {
      loads += 1;
      if (loads === 1) {
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      }
      if (loads === 2) {
        void refresh.run('workspace', load, (value) => values.push(value), () => undefined, true);
      }
      return loads;
    };

    const first = refresh.run('workspace', load, (value) => values.push(value), () => undefined);
    await Promise.resolve();
    const invalidation = refresh.run(
      'workspace',
      load,
      (value) => values.push(value),
      () => undefined,
      true,
    );
    assert.strictEqual(loads, 1);
    finishFirst?.(1);
    await Promise.all([first, invalidation]);

    assert.strictEqual(loads, 2, 'feedback during the follow-up must not start an endless read loop');
    assert.deepStrictEqual(values, [2], 'the last bounded read still updates the current snapshot');

    await refresh.run('workspace', load, (value) => values.push(value), () => undefined);
    assert.strictEqual(loads, 3, 'a later independent invalidation can still read new external state');
    assert.deepStrictEqual(values, [2, 3]);
  });

  test('a new context rejects values from an older pending read', async () => {
    const refresh = new ContextualRefresh<string>();
    let finishOld: ((value: string) => void) | undefined;
    const values: string[] = [];
    const old = refresh.run(
      'old',
      () => new Promise((resolve) => {
        finishOld = resolve;
      }),
      (value) => values.push(value),
      () => undefined,
    );
    await Promise.resolve();
    await refresh.run('new', async () => 'current', (value) => values.push(value), () => undefined);
    finishOld?.('stale');
    await old;

    assert.deepStrictEqual(values, ['current']);
  });
});
