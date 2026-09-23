import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { parseCommandLine } from '../features/environment/commands';
import { probableProfile } from '../features/environment/provider';

suite('Environment UI helpers', () => {
  test('parses a direct executable command without invoking a shell', () => {
    assert.deepStrictEqual(parseCommandLine('npm run "dev server"'), [
      'npm',
      'run',
      'dev server',
    ]);
  });

  test('rejects shell control syntax for environment runs', () => {
    assert.throws(
      () => parseCommandLine('npm run dev && curl https://example.test'),
      /shell syntax is not supported/i,
    );
  });

  test('maps dotenv filename conventions to a probable profile only', () => {
    assert.strictEqual(probableProfile('/workspace/.env'), 'development');
    assert.strictEqual(probableProfile('/workspace/.env.staging'), 'staging');
    assert.strictEqual(probableProfile('/workspace/config.env'), 'unknown');
  });
});
