import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { ContextualRefresh } from '../features/refresh/contextualRefresh';

suite('Contextual refresh', () => {
  test('a mutation during a follow-up read remains pending until latest state is published', async () => {
    const refresh = new ContextualRefresh<number>();
    let persistedRevision = 0;
    let loads = 0;
    let displayedRevision: number | undefined;
    const started = [deferred<void>(), deferred<void>(), deferred<void>()];
    const completions = [deferred<void>(), deferred<void>(), deferred<void>()];

    const load = async (): Promise<number> => {
      const capturedRevision = persistedRevision;
      const index = loads++;
      started[index]?.resolve();
      await completions[index]?.promise;
      return capturedRevision;
    };

    const first = refresh.run(
      'workspace',
      load,
      (revision) => { displayedRevision = revision; },
      () => undefined,
    );
    await started[0]?.promise;

    persistedRevision = 1;
    const firstInvalidation = refresh.run(
      'workspace',
      load,
      (revision) => { displayedRevision = revision; },
      () => undefined,
      true,
    );
    completions[0]?.resolve();
    await started[1]?.promise;

    persistedRevision = 2;
    const followUpInvalidation = refresh.run(
      'workspace',
      load,
      (revision) => { displayedRevision = revision; },
      () => undefined,
      true,
    );
    completions[1]?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (loads > 2) {
      completions[2]?.resolve();
    }
    await Promise.all([first, firstInvalidation, followUpInvalidation]);

    assert.strictEqual(loads, 3);
    assert.strictEqual(displayedRevision, 2);
  });

  test('redundant presentation requests coalesce without invalidating the read', async () => {
    const refresh = new ContextualRefresh<number>();
    const completion = deferred<number>();
    let loads = 0;
    const values: number[] = [];
    const load = async () => {
      loads += 1;
      return completion.promise;
    };
    const publish = (value: number) => values.push(value);

    const first = refresh.run('workspace', load, publish, () => undefined);
    await Promise.resolve();
    const second = refresh.run('workspace', load, publish, () => undefined);
    const third = refresh.run('workspace', load, publish, () => undefined);
    completion.resolve(7);
    await Promise.all([first, second, third]);

    assert.strictEqual(loads, 1);
    assert.deepStrictEqual(values, [7]);
  });

  test('a new context rejects values from an older pending read', async () => {
    const refresh = new ContextualRefresh<string>();
    const oldRead = deferred<string>();
    const values: string[] = [];
    const old = refresh.run(
      'old',
      () => oldRead.promise,
      (value) => values.push(value),
      () => undefined,
    );
    await Promise.resolve();
    await refresh.run('new', async () => 'current', (value) => values.push(value), () => undefined);
    oldRead.resolve('stale');
    await old;

    assert.deepStrictEqual(values, ['current']);
  });

  test('dispose rejects a pending value and prevents new reads', async () => {
    const refresh = new ContextualRefresh<number>();
    const pending = deferred<number>();
    const values: number[] = [];
    let loads = 0;
    const request = refresh.run(
      'workspace',
      () => {
        loads += 1;
        return pending.promise;
      },
      (value) => values.push(value),
      () => undefined,
    );
    await Promise.resolve();
    refresh.dispose();
    pending.resolve(7);
    await request;
    await refresh.run('workspace', async () => {
      loads += 1;
      return 8;
    }, (value) => values.push(value), () => undefined);

    assert.deepStrictEqual(values, []);
    assert.strictEqual(loads, 1);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
