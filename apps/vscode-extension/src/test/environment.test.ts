import * as assert from 'node:assert';

import { suite, test } from 'mocha';

import { CliClient } from '../core/cliClient';
import {
  createImportEnvironmentCommand,
  parseCommandLine,
  type EnvironmentCommandDependencies,
} from '../features/environment/commands';
import { probableProfile } from '../features/environment/provider';
import { EnvironmentDotenvItem } from '../features/environment/view';
import type { EnvironmentProfileStatus } from '../types';

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

  test('requires explicit confirmation before replacing configured dotenv values', async () => {
    let importInput: Parameters<CliClient['importEnvironment']>[0] | undefined;
    let warning = '';
    const command = createImportEnvironmentCommand(environmentDependencies({
      profile: profile('development', 'configured'),
      showWarningMessage: async (message) => {
        warning = message;
        return 'Cancel';
      },
      importEnvironment: async (input) => {
        importInput = input;
      },
    }));

    await command(new EnvironmentDotenvItem('/workspace/.env', 'development', '/workspace'));

    assert.match(warning, /Missing keys will be removed/);
    assert.strictEqual(importInput, undefined);
  });

  test('passes replacement only after explicit profile confirmation', async () => {
    let importInput: Parameters<CliClient['importEnvironment']>[0] | undefined;
    const command = createImportEnvironmentCommand(environmentDependencies({
      profile: profile('development', 'configured'),
      showWarningMessage: async () => 'Replace Profile',
      importEnvironment: async (input) => {
        importInput = input;
      },
    }));

    await command(new EnvironmentDotenvItem('/workspace/.env', 'development', '/workspace'));

    assert.deepStrictEqual(importInput, {
      workspaceRoot: '/workspace',
      source: '/workspace/.env',
      profile: 'development',
      replace: true,
    });
  });

  test('imports into an unconfigured profile without replacement', async () => {
    let warningCalls = 0;
    let importInput: Parameters<CliClient['importEnvironment']>[0] | undefined;
    const command = createImportEnvironmentCommand(environmentDependencies({
      profile: profile('development', 'missing'),
      showWarningMessage: async () => {
        warningCalls += 1;
        return 'Replace Profile';
      },
      importEnvironment: async (input) => {
        importInput = input;
      },
    }));

    await command(new EnvironmentDotenvItem('/workspace/.env', 'development', '/workspace'));

    assert.strictEqual(warningCalls, 0);
    assert.strictEqual(importInput?.replace, false);
  });
});

function profile(
  name: string,
  variableStatus: EnvironmentProfileStatus['variables'][number]['status'],
): EnvironmentProfileStatus {
  return {
    profile: name,
    status: 'ready',
    scope: 'this-machine',
    variables: [{
      name: 'API_KEY',
      status: variableStatus,
      source: 'encrypted-profile',
      secret: true,
      required: true,
    }],
  };
}

function environmentDependencies(input: {
  profile: EnvironmentProfileStatus;
  showWarningMessage: EnvironmentCommandDependencies['showWarningMessage'];
  importEnvironment: NonNullable<Partial<CliClient>['importEnvironment']>;
}): EnvironmentCommandDependencies {
  const cliClient = {
    environmentProfiles: async () => ({ profiles: [input.profile] }),
    importEnvironment: input.importEnvironment,
  } as unknown as CliClient;
  return {
    cliClient,
    getWorkspaceRoot: () => '/workspace',
    refresh: () => undefined,
    setRuntimeState: () => undefined,
    discoverDotenv: async () => [],
    showErrorMessage: async (message) => {
      throw new Error(message);
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: input.showWarningMessage,
  };
}
