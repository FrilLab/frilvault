import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { CliClient } from '../core/cliClient';

suite('CliClient', () => {
  test('uses the bundled CLI by default when cliPath is empty', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: (filePath) => filePath === '/extension/bin/darwin-arm64/flvt',
      access: async () => undefined,
      execFile: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);

        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        return { stdout: '[]', stderr: '' };
      },
      outputChannel: {
        appendLine(value) {
          logs.push(value);
        },
      },
    });

    const notes = await cliClient.listNotes('/workspace', 'src/sample.ts');

    assert.deepStrictEqual(notes, []);
    assert.deepStrictEqual(calls, [
      '/extension/bin/darwin-arm64/flvt --version',
      '/extension/bin/darwin-arm64/flvt list --file src/sample.ts --format json',
    ]);
    assert.ok(logs.some((line) => line.includes('path=/extension/bin/darwin-arm64/flvt')));
  });

  test('prefers a custom cliPath override over the bundled CLI', async () => {
    const calls: string[] = [];
    const cliClient = new CliClient({
      getConfiguredCliPath: () => '/custom/flvt',
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);

        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        return { stdout: '[]', stderr: '' };
      },
    });

    await cliClient.listNotes('/workspace', 'src/sample.ts');

    assert.deepStrictEqual(calls, [
      '/custom/flvt --version',
      '/custom/flvt list --file src/sample.ts --format json',
    ]);
  });

  test('reports a clear error when no bundled CLI is available', async () => {
    const cliClient = new CliClient({
      extensionPath: '/extension',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => false,
    });

    await assert.rejects(
      async () => {
        await cliClient.listNotes('/workspace', 'src/sample.ts');
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /frilvault cli could not be started/i);
        assert.match(error.message, /no bundled cli was found/i);
        return true;
      },
    );
  });

  test('reports non-executable bundled binaries before spawning', async () => {
    const cliClient = new CliClient({
      extensionPath: '/extension',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => {
        const error = new Error('permission denied') as Error & { code?: string };
        error.code = 'EACCES';
        throw error;
      },
    });

    await assert.rejects(
      async () => {
        await cliClient.listNotes('/workspace', 'src/sample.ts');
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not runnable/i);
        return true;
      },
    );
  });

  test('loads workspace note counts from the index command', async () => {
    const calls: string[] = [];
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);

        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        return {
          stdout: JSON.stringify({
            version: 1,
            files: [{ source_file: 'src/main.rs', note_count: 2, exists: true }],
          }),
          stderr: '',
        };
      },
    });

    const index = await cliClient.workspaceIndex('/workspace');

    assert.strictEqual(index.files[0]?.note_count, 2);
    assert.ok(calls.some((call) => call.includes('index --format json')));
  });

  test('initializes a local vault through the CLI JSON boundary', async () => {
    const calls: string[] = [];
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);

        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        return {
          stdout: JSON.stringify({ mode: 'local', git_exclude: 'added' }),
          stderr: '',
        };
      },
    });

    const result = await cliClient.initializeLocal('/workspace');

    assert.deepStrictEqual(result, { mode: 'local', git_exclude: 'added' });
    assert.ok(calls.some((call) => call.endsWith('init --format json')));
  });

  test('searches notes by tag through the CLI JSON boundary', async () => {
    const calls: string[] = [];
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);

        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        return { stdout: '[]', stderr: '' };
      },
    });

    const notes = await cliClient.searchNotes({
      workspaceRoot: '/workspace',
      tag: '#todo',
    });

    assert.deepStrictEqual(notes, []);
    assert.ok(calls.some((call) => call.endsWith('search --tag #todo --format json')));
  });

  test('searches notes with repeated tags and a tag query through the CLI boundary', async () => {
    const calls: string[][] = [];
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (_file, args) => {
        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        calls.push(args);
        return { stdout: '[]', stderr: '' };
      },
    });

    await cliClient.searchNotes({
      workspaceRoot: '/workspace',
      tags: ['performance', 'parser'],
    });
    await cliClient.searchNotes({
      workspaceRoot: '/workspace',
      tagQuery: 'tag:bug OR tag:security',
    });

    assert.deepStrictEqual(calls, [
      ['search', '--tag', 'performance', '--tag', 'parser', '--format', 'json'],
      ['search', '--tag-query', 'tag:bug OR tag:security', '--format', 'json'],
    ]);
  });

  test('fails fast when the CLI version does not match the extension expectation', async () => {
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.0.1',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (_file, args) => {
        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }

        return { stdout: '[]', stderr: '' };
      },
    });

    await assert.rejects(
      async () => {
        await cliClient.listNotes('/workspace', 'src/sample.ts');
      },
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(
          error.message,
          'FrilVault CLI version mismatch. Expected 0.0.1, found 0.1.0.',
        );
        return true;
      },
    );
  });

  test('assigns and removes tag colors through the existing CLI boundary', async () => {
    const calls: string[][] = [];
    const cliClient = new CliClient({
      extensionPath: '/extension',
      extensionVersion: '0.1.0',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: () => true,
      access: async () => undefined,
      execFile: async (_file, args) => {
        if (args[0] === '--version') {
          return { stdout: 'flvt 0.1.0\n', stderr: '' };
        }
        calls.push(args);
        return { stdout: '{}', stderr: '' };
      },
    });

    await cliClient.tagColorSet('/workspace', 'bug', 'red');
    await cliClient.tagColorRemove('/workspace', 'bug');

    assert.deepStrictEqual(calls, [
      ['tag', 'color', 'set', 'bug', 'red', '--format', 'json'],
      ['tag', 'color', 'remove', 'bug', '--format', 'json'],
    ]);
  });
});
