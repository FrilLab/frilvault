import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { suite, test } from 'mocha';

import { COMMAND_IDS } from '../constants/ids';
import { initializeLocalVault } from '../features/initialization/localVault';
import { runOptionalPostSaveTasks } from '../features/post-save/tasks';

suite('Post-save boundaries', () => {
  test('initializeLocalVault reports tracked vaults', async () => {
    let warning = '';

    await initializeLocalVault({
      getWorkspaceRoot: () => '/tmp/workspace',
      cliClient: {
        initializeLocal: async () => ({ mode: 'local', git_exclude: 'vault_tracked' }),
      } as never,
      showWarningMessage: async (message) => {
        warning = message;
        return undefined;
      },
    });

    assert.match(warning, /already tracked by Git/i);
  });

  test('runOptionalPostSaveTasks reports initialization failures without throwing', async () => {
    let warning = '';

    await runOptionalPostSaveTasks(
      {
        getWorkspaceRoot: () => '/tmp/workspace',
        cliClient: {
          initializeLocal: async () => {
            throw new Error('initialization failed');
          },
        } as never,
      },
      async (message) => {
        warning = message;
        return undefined;
      },
    );

    assert.match(warning, /local vault initialization failed/i);
  });
});

suite('Canonical add note command registration', () => {
  test('package.json exposes frilvault.addNote without createNoteHere', () => {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      activationEvents?: string[];
      contributes?: {
        commands?: Array<{ command: string }>;
      };
    };

    const commands = packageJson.contributes?.commands?.map((entry) => entry.command) ?? [];

    assert.ok(commands.includes(COMMAND_IDS.addNote));
    assert.ok(!commands.includes('frilvault.createNoteHere'));
    assert.ok(packageJson.activationEvents?.includes(`onCommand:${COMMAND_IDS.addNote}`));
    assert.ok(!packageJson.activationEvents?.includes('onCommand:frilvault.createNoteHere'));
  });
});
