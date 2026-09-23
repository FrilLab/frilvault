import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { suite, test } from 'mocha';

import { CliClient, CliCommandError } from '../core/cliClient';
import { createEnableCommand } from '../features/enablement/command';
import {
  FRILVAULT_ENABLED_KEY,
  isFrilVaultEnabled,
  setFrilVaultEnabled,
} from '../features/enablement/state';
import type { WorkspaceStatus } from '../types';

suite('Enablement initialization flow', () => {
  test('cancel leaves enablement off and does not initialize or refresh', async () => {
    let initializationCalls = 0;
    let refreshCalls = 0;
    const state = createWorkspaceState();
    const informationCalls: string[][] = [];
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [new CliCommandError('missing', 'workspace_not_found')],
        initializeLocal: async () => {
          initializationCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
      }),
      refreshUi: async () => {
        refreshCalls += 1;
      },
      clearUi: () => undefined,
      showInformationMessage: async (_message, ...items) => {
        informationCalls.push(items);
        return 'Cancel';
      },
    });

    await command();

    assert.deepStrictEqual(informationCalls[0], [
      'Initialize Local Vault',
      'Initialize Shared Vault',
      'Choose Existing/External Vault',
      'Cancel',
    ]);
    assert.strictEqual(initializationCalls, 0);
    assert.strictEqual(refreshCalls, 0);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), false);
    assert.strictEqual(state.get(FRILVAULT_ENABLED_KEY), undefined);
  });

  test('Local choice delegates to CLI init before enabling and refreshing', async () => {
    let initializationCalls = 0;
    let statusCalls = 0;
    let refreshCalls = 0;
    const state = createWorkspaceState();
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [
          new CliCommandError('missing', 'workspace_not_found'),
          workspaceStatus('local', 'excluded'),
        ],
        initializeLocal: async () => {
          initializationCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
        onStatus: () => {
          statusCalls += 1;
        },
      }),
      refreshUi: async () => {
        refreshCalls += 1;
      },
      clearUi: () => undefined,
      showInformationMessage: async (_message, ...items) =>
        items.length > 0 ? 'Initialize Local Vault' : undefined,
    });

    await command();

    assert.strictEqual(initializationCalls, 1);
    assert.strictEqual(statusCalls, 2);
    assert.strictEqual(refreshCalls, 1);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), true);
  });

  test('Shared choice delegates to `flvt init --shared`', async () => {
    let localCalls = 0;
    let sharedCalls = 0;
    const state = createWorkspaceState();
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [
          new CliCommandError('missing', 'workspace_not_found'),
          workspaceStatus('shared', 'trackable'),
        ],
        initializeLocal: async () => {
          localCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
        initializeShared: async () => {
          sharedCalls += 1;
          return { mode: 'shared', git_exclude: null };
        },
      }),
      refreshUi: async () => undefined,
      clearUi: () => undefined,
      showInformationMessage: async (_message, ...items) =>
        items.length > 0 ? 'Initialize Shared Vault' : undefined,
    });

    await command();

    assert.strictEqual(localCalls, 0);
    assert.strictEqual(sharedCalls, 1);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), true);
  });

  test('configured existing vault is validated before enabling', async () => {
    let localCalls = 0;
    let refreshCalls = 0;
    const state = createWorkspaceState();
    let choiceCalls = 0;
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [
          new CliCommandError('missing', 'workspace_not_found'),
          workspaceStatus('shared', 'trackable'),
        ],
        initializeLocal: async () => {
          localCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
      }),
      refreshUi: async () => {
        refreshCalls += 1;
      },
      clearUi: () => undefined,
      showInformationMessage: async (_message, ...items) => {
        if (items.length > 0) {
          choiceCalls += 1;
          return 'Choose Existing/External Vault';
        }
        return undefined;
      },
    });

    await command();

    assert.strictEqual(choiceCalls, 1);
    assert.strictEqual(localCalls, 0);
    assert.strictEqual(refreshCalls, 1);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), true);
  });

  test('cancelled local Git repair does not enable the workspace', async () => {
    let initializationCalls = 0;
    const state = createWorkspaceState();
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [workspaceStatus('local', 'trackable')],
        initializeLocal: async () => {
          initializationCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
      }),
      refreshUi: async () => undefined,
      clearUi: () => undefined,
      showWarningMessage: async (_message, ...items) => {
        assert.deepStrictEqual(items, [
          'Repair Local Exclusion',
          'Enable Without Repair',
          'Cancel',
        ]);
        return 'Cancel';
      },
    });

    await command();

    assert.strictEqual(initializationCalls, 0);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), false);
  });

  test('explicitly repairs an existing Local vault through CLI initialization', async () => {
    let initializationCalls = 0;
    const state = createWorkspaceState();
    let statusCalls = 0;
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [
          workspaceStatus('local', 'trackable'),
          workspaceStatus('local', 'excluded'),
        ],
        initializeLocal: async () => {
          initializationCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
        onStatus: () => {
          statusCalls += 1;
        },
      }),
      refreshUi: async () => undefined,
      clearUi: () => undefined,
      showWarningMessage: async (_message, ...items) => {
        assert.ok(items.includes('Repair Local Exclusion'));
        return 'Repair Local Exclusion';
      },
      showInformationMessage: async () => undefined,
    });

    await command();

    assert.strictEqual(initializationCalls, 1);
    assert.strictEqual(statusCalls, 2);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), true);
  });

  test('a remembered enabled workspace with a missing vault is disabled on reload', async () => {
    let initializationCalls = 0;
    let refreshCalls = 0;
    let clearCalls = 0;
    let shownError = '';
    const state = createWorkspaceState();
    await setFrilVaultEnabled(state, '/workspace', true);
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [new CliCommandError('missing', 'workspace_not_found')],
        initializeLocal: async () => {
          initializationCalls += 1;
          return { mode: 'local', git_exclude: 'added' };
        },
      }),
      refreshUi: async () => {
        refreshCalls += 1;
      },
      clearUi: () => {
        clearCalls += 1;
      },
      showErrorMessage: async (message) => {
        shownError = message;
        return undefined;
      },
      showInformationMessage: async (_message, ...items) => {
        assert.deepStrictEqual(items, []);
        return undefined;
      },
    });

    await command();

    assert.match(shownError, /Run Enable to choose an initialization option/);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), false);
    assert.strictEqual(initializationCalls, 0);
    assert.strictEqual(refreshCalls, 0);
    assert.strictEqual(clearCalls, 1);
  });

  test('Local tracked vault warns without running an automatic untrack command', async () => {
    let initializationCalls = 0;
    const state = createWorkspaceState();
    let warned = false;
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [workspaceStatus('local', 'tracked')],
        initializeLocal: async () => {
          initializationCalls += 1;
          return { mode: 'local', git_exclude: 'vault_tracked' };
        },
      }),
      refreshUi: async () => undefined,
      clearUi: () => undefined,
      showWarningMessage: async (message, ...items) => {
        warned = true;
        assert.match(message, /cannot untrack files/i);
        assert.deepStrictEqual(items, ['Enable', 'Cancel']);
        return 'Enable';
      },
      showInformationMessage: async () => undefined,
    });

    await command();

    assert.strictEqual(warned, true);
    assert.strictEqual(initializationCalls, 0);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), true);
  });

  test('failed explicit initialization keeps enablement disabled', async () => {
    let refreshCalls = 0;
    let shownError = '';
    const state = createWorkspaceState();
    const command = createEnableCommand({
      getWorkspaceRoot: () => '/workspace',
      workspaceState: state,
      cliClient: fakeCli({
        statuses: [new CliCommandError('missing', 'workspace_not_found')],
        initializeShared: async () => {
          throw new Error('initialization failed');
        },
      }),
      refreshUi: async () => {
        refreshCalls += 1;
      },
      clearUi: () => undefined,
      showInformationMessage: async (_message, ...items) =>
        items.length > 0 ? 'Initialize Shared Vault' : undefined,
      showErrorMessage: async (message) => {
        shownError = message;
        return undefined;
      },
    });

    await command();

    assert.strictEqual(shownError, 'initialization failed');
    assert.strictEqual(refreshCalls, 0);
    assert.strictEqual(isFrilVaultEnabled(state, '/workspace'), false);
  });
});

function workspaceStatus(
  mode: WorkspaceStatus['mode'],
  gitTracking: WorkspaceStatus['git_tracking'],
): WorkspaceStatus {
  return {
    vault_path: '.vault',
    mode,
    git_tracking: gitTracking,
    note_count: 0,
  };
}

function fakeCli(input: {
  statuses: Array<WorkspaceStatus | Error>;
  initializeLocal?: CliClient['initializeLocal'];
  initializeShared?: CliClient['initializeShared'];
  onStatus?: () => void;
}): CliClient {
  let statusIndex = 0;
  return {
    workspaceStatus: async () => {
      input.onStatus?.();
      const next = input.statuses[statusIndex++];
      if (next instanceof Error) {
        throw next;
      }
      if (!next) {
        throw new Error('No workspace status fixture remains.');
      }
      return next;
    },
    initializeLocal: input.initializeLocal ?? (async () => ({
      mode: 'local',
      git_exclude: 'added',
    })),
    initializeShared: input.initializeShared ?? (async () => ({
      mode: 'shared',
      git_exclude: null,
    })),
  } as unknown as CliClient;
}

function createWorkspaceState(): vscode.Memento {
  const storage = new Map<string, unknown>();
  return {
    keys: () => [...storage.keys()],
    get: <T>(key: string) => storage.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      storage.set(key, value);
    },
  };
}
