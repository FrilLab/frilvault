import { constants as fsConstants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  NoteView,
  RepairSuggestion,
  SyncResult,
  TagOperationResult,
  TagColor,
  TagSummary,
  WorkspaceExplorer,
  WorkspaceHealth,
  WorkspaceIndex,
  WorkspaceStats,
  WorkspaceStatus,
  EnvironmentProfilesResult,
  EnvironmentProfileStatus,
} from '../types';
import { parseJson } from '../utils/parser';
import {
  getConfiguredCliPath,
  resolveCliPath,
  type CliResolution,
} from './bundledCli';

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

type ExecFileLike = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
  },
) => Promise<ExecFileResult>;

type SpawnWithInputLike = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    input: string;
  },
) => Promise<ExecFileResult>;

type RunCommandLike = (
  file: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; onSpawn?: () => void },
) => Promise<void>;

export interface OutputChannelLike {
  appendLine(value: string): void;
}

export interface CliClientDependencies {
  getConfiguredCliPath?: () => string;
  getConfiguredVaultPath?: () => string | undefined;
  extensionPath?: string;
  extensionVersion?: string;
  outputChannel?: OutputChannelLike;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  execFile?: ExecFileLike;
  access?: (path: string, mode: number) => Promise<void>;
  existsSync?: (path: string) => boolean;
  spawnWithInput?: SpawnWithInputLike;
  runCommand?: RunCommandLike;
}

export interface AddLineNoteInput {
  workspaceRoot: string;
  sourceFile: string;
  line: number;
  column: number;
  content: string;
  tags?: string[];
}

export interface AddSymbolNoteInput {
  workspaceRoot: string;
  sourceFile: string;
  symbol: string;
  kind: string;
  signature?: string;
  lineHint?: number;
  content: string;
  tags?: string[];
}

export interface UpdateNoteInput {
  workspaceRoot: string;
  sourceFile: string;
  noteId: string;
  content: string;
  tags?: string[];
  clearTags?: boolean;
  expectedUpdatedAt?: string;
}

export interface InitResult {
  mode: 'local' | 'shared';
  git_exclude:
    | 'added'
    | 'already_excluded'
    | 'not_git_repository'
    | 'vault_tracked'
    | null;
}

export class CliCommandError extends Error {
  public constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'CliCommandError';
  }
}

export function isWorkspaceNotFoundError(error: unknown): error is CliCommandError {
  return error instanceof CliCommandError && error.code === 'workspace_not_found';
}

export interface SearchNotesInput {
  workspaceRoot: string;
  keyword?: string;
  sourceFile?: string;
  symbol?: string;
  tag?: string;
  tags?: string[];
  tagQuery?: string;
  signal?: AbortSignal;
}

/**
 * Executes FrilVault CLI commands on behalf of the extension.
 *
 * Each method resolves the CLI path, validates compatibility, runs the
 * command in the workspace root, and parses JSON responses into typed DTOs.
 */
export class CliClient {
  private readonly dependencies: Required<
    Pick<
      CliClientDependencies,
      'platform' | 'arch' | 'execFile' | 'access' | 'existsSync' | 'spawnWithInput' | 'runCommand'
    >
  > &
    Omit<
      CliClientDependencies,
      'platform' | 'arch' | 'execFile' | 'access' | 'existsSync' | 'spawnWithInput' | 'runCommand'
    >;
  private readonly verifiedCliPaths = new Map<string, Promise<void>>();

  public constructor(
    dependencies: CliClientDependencies | (() => string) = {},
  ) {
    const normalized =
      typeof dependencies === 'function'
        ? { getConfiguredCliPath: dependencies }
        : dependencies;

    this.dependencies = {
      getConfiguredCliPath: normalized.getConfiguredCliPath,
      getConfiguredVaultPath: normalized.getConfiguredVaultPath,
      extensionPath: normalized.extensionPath,
      extensionVersion: normalized.extensionVersion,
      outputChannel: normalized.outputChannel,
      platform: normalized.platform ?? process.platform,
      arch: normalized.arch ?? process.arch,
      execFile: normalized.execFile ?? execFileAsync,
      access: normalized.access ?? access,
      existsSync: normalized.existsSync ?? existsSync,
      spawnWithInput: normalized.spawnWithInput ?? spawnWithInput,
      runCommand: normalized.runCommand
        ?? (normalized.execFile
          ? async (file, args, options) => {
              options.onSpawn?.();
              await normalized.execFile!(file, args, options);
            }
          : runCommandWithoutBuffer),
    };
  }

  public async addLineNote(input: AddLineNoteInput): Promise<NoteView> {
    const args = [
      'add',
      '--file',
      input.sourceFile,
      '--line',
      String(input.line),
      '--column',
      String(input.column),
      '--content',
      input.content,
      '--format',
      'json',
    ];

    for (const tag of input.tags ?? []) {
      args.push('--tag', tag);
    }

    const stdout = await this.execInWorkspace(input.workspaceRoot, args);
    return parseJson<NoteView>(stdout);
  }

  public async initializeLocal(workspaceRoot: string): Promise<InitResult> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['init', '--format', 'json']);
    return parseJson<InitResult>(stdout);
  }

  public async initializeShared(workspaceRoot: string): Promise<InitResult> {
    const stdout = await this.execInWorkspace(workspaceRoot, [
      'init',
      '--shared',
      '--format',
      'json',
    ]);
    return parseJson<InitResult>(stdout);
  }

  public async workspaceStatus(workspaceRoot: string): Promise<WorkspaceStatus> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['status', '--format', 'json']);
    return parseJson<WorkspaceStatus>(stdout);
  }

  public async environmentProfiles(
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<EnvironmentProfilesResult> {
    const stdout = await this.execInWorkspace(
      workspaceRoot,
      ['env', 'profiles', '--format', 'json'],
      signal,
    );
    return parseJson<EnvironmentProfilesResult>(stdout);
  }

  public async environmentProfile(
    workspaceRoot: string,
    profile: string,
    signal?: AbortSignal,
  ): Promise<EnvironmentProfileStatus> {
    const stdout = await this.execInWorkspace(
      workspaceRoot,
      ['env', 'list', '--profile', profile, '--format', 'json'],
      signal,
    );
    return parseJson<EnvironmentProfileStatus>(stdout);
  }

  public async setEnvironmentValue(input: {
    workspaceRoot: string;
    profile: string;
    key: string;
    value: string;
  }): Promise<void> {
    await this.execInWorkspaceWithStdin(
      input.workspaceRoot,
      ['env', 'set', input.key, '--profile', input.profile, '--stdin', '--format', 'json'],
      `${input.value}\n`,
    );
  }

  public async importEnvironment(input: {
    workspaceRoot: string;
    source: string;
    profile: string;
    replace?: boolean;
  }): Promise<void> {
    const args = [
      'env',
      'import',
      input.source,
      '--profile',
      input.profile,
    ];
    if (input.replace) {
      args.push('--replace', '--yes');
    }
    args.push('--format', 'json');
    await this.execInWorkspace(input.workspaceRoot, args);
  }

  public async runEnvironment(input: {
    workspaceRoot: string;
    profile: string;
    command: string[];
    signal?: AbortSignal;
    onSpawn?: () => void;
  }): Promise<string> {
    return this.execInWorkspace(
      input.workspaceRoot,
      ['env', 'run', '--profile', input.profile, '--', ...input.command],
      input.signal,
      true,
      input.onSpawn,
    );
  }

  public async addSymbolNote(input: AddSymbolNoteInput): Promise<NoteView> {
    const args = [
      'add',
      '--file',
      input.sourceFile,
      '--symbol',
      input.symbol,
      '--kind',
      input.kind,
      '--content',
      input.content,
      '--format',
      'json',
    ];

    if (input.signature) {
      args.push('--signature', input.signature);
    }

    if (input.lineHint) {
      args.push('--line-hint', String(input.lineHint));
    }

    for (const tag of input.tags ?? []) {
      args.push('--tag', tag);
    }

    const stdout = await this.execInWorkspace(input.workspaceRoot, args);
    return parseJson<NoteView>(stdout);
  }

  public async listNotes(workspaceRoot: string, sourceFile: string): Promise<NoteView[]> {
    const stdout = await this.execInWorkspace(workspaceRoot, [
      'list',
      '--file',
      sourceFile,
      '--format',
      'json',
    ]);

    return parseJson<NoteView[]>(stdout);
  }

  public async searchNotes(input: SearchNotesInput): Promise<NoteView[]> {
    const args = ['search'];

    if (input.keyword) {
      args.push(input.keyword);
    }

    if (input.sourceFile) {
      args.push('--file', input.sourceFile);
    }

    if (input.symbol) {
      args.push('--symbol', input.symbol);
    }

    if (input.tag) {
      args.push('--tag', input.tag);
    }

    for (const tag of input.tags ?? []) {
      args.push('--tag', tag);
    }

    if (input.tagQuery) {
      args.push('--tag-query', input.tagQuery);
    }

    args.push('--format', 'json');

    const stdout = await this.execInWorkspace(input.workspaceRoot, args, input.signal);

    return parseJson<NoteView[]>(stdout);
  }

  public async updateNote(input: UpdateNoteInput): Promise<NoteView> {
    const args = [
      'update',
      '--file',
      input.sourceFile,
      '--id',
      input.noteId,
      '--content',
      input.content,
      '--format',
      'json',
    ];

    if (input.clearTags) {
      args.push('--clear-tags');
    } else {
      for (const tag of input.tags ?? []) {
        args.push('--tag', tag);
      }
    }

    if (input.expectedUpdatedAt) {
      args.push('--expected-updated-at', input.expectedUpdatedAt);
    }

    const stdout = await this.execInWorkspace(input.workspaceRoot, args);
    return parseJson<NoteView>(stdout);
  }

  public async deleteNote(
    workspaceRoot: string,
    sourceFile: string,
    noteId: string,
  ): Promise<void> {
    await this.execInWorkspace(workspaceRoot, [
      'delete',
      '--file',
      sourceFile,
      '--id',
      noteId,
    ]);
  }

  public async stats(workspaceRoot: string): Promise<string> {
    return this.execInWorkspace(workspaceRoot, ['stats']);
  }

  public async health(workspaceRoot: string): Promise<string> {
    return this.execInWorkspace(workspaceRoot, ['health']);
  }

  public async repair(workspaceRoot: string, apply = false): Promise<string> {
    return this.execInWorkspace(workspaceRoot, apply ? ['repair', '--apply'] : ['repair']);
  }

  public async workspaceStats(workspaceRoot: string): Promise<WorkspaceStats> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['stats', '--format', 'json']);
    return parseJson<WorkspaceStats>(stdout);
  }

  public async workspaceIndex(workspaceRoot: string): Promise<WorkspaceIndex> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['index', '--format', 'json']);
    return parseJson<WorkspaceIndex>(stdout);
  }

  public async workspaceExplorer(workspaceRoot: string): Promise<WorkspaceExplorer> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['explorer', '--format', 'json']);
    return parseJson<WorkspaceExplorer>(stdout);
  }

  public async workspaceHealth(workspaceRoot: string): Promise<WorkspaceHealth> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['health', '--format', 'json']);
    return parseJson<WorkspaceHealth>(stdout);
  }

  public async repairSuggestions(workspaceRoot: string): Promise<RepairSuggestion[]> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['repair', '--format', 'json']);
    return parseJson<RepairSuggestion[]>(stdout);
  }

  public async applyRepairs(workspaceRoot: string): Promise<number> {
    const stdout = await this.execInWorkspace(workspaceRoot, [
      'repair',
      '--apply',
      '--format',
      'json',
    ]);
    return parseJson<number>(stdout);
  }

  public async sync(workspaceRoot: string): Promise<SyncResult> {
    const stdout = await this.execInWorkspace(workspaceRoot, ['sync', '--format', 'json']);
    return parseJson<SyncResult>(stdout);
  }

  public async checkGitignore(workspaceRoot: string): Promise<{ ignored: boolean }> {
    const stdout = await this.execInWorkspace(workspaceRoot, [
      'gitignore',
      'check',
      '--format',
      'json',
    ]);

    return parseJson<{ ignored: boolean }>(stdout);
  }

  public async addGitignoreEntry(workspaceRoot: string): Promise<void> {
    await this.execInWorkspace(workspaceRoot, ['gitignore', 'add']);
  }

  public async resolveNoteUri(workspaceRoot: string, uri: string): Promise<NoteView> {
    const stdout = await this.execInWorkspace(workspaceRoot, [
      'resolve-uri',
      '--uri',
      uri,
      '--format',
      'json',
    ]);

    return parseJson<NoteView>(stdout);
  }

  public async tagRename(
    workspaceRoot: string,
    oldTag: string,
    newTag: string,
    dryRun = false,
  ): Promise<TagOperationResult> {
    const args = ['tag', 'rename', oldTag, newTag, '--format', 'json'];
    if (dryRun) {
      args.push('--dry-run');
    }
    const stdout = await this.execInWorkspace(workspaceRoot, args);
    return parseJson<TagOperationResult>(stdout);
  }

  public async tagMerge(
    workspaceRoot: string,
    sources: string[],
    into: string,
    dryRun = false,
  ): Promise<TagOperationResult> {
    const args = ['tag', 'merge', ...sources, '--into', into, '--format', 'json'];
    if (dryRun) {
      args.push('--dry-run');
    }
    const stdout = await this.execInWorkspace(workspaceRoot, args);
    return parseJson<TagOperationResult>(stdout);
  }

  public async tagRemove(
    workspaceRoot: string,
    tag: string,
    dryRun = false,
  ): Promise<TagOperationResult> {
    const args = ['tag', 'remove', tag, '--yes', '--format', 'json'];
    if (dryRun) {
      args.push('--dry-run');
    }
    const stdout = await this.execInWorkspace(workspaceRoot, args);
    return parseJson<TagOperationResult>(stdout);
  }

  public async tagList(
    workspaceRoot: string,
    unused = false,
  ): Promise<TagSummary[]> {
    const args = ['tag', 'list', '--format', 'json'];
    if (unused) {
      args.push('--unused');
    }
    const stdout = await this.execInWorkspace(workspaceRoot, args);
    return parseJson<TagSummary[]>(stdout);
  }

  public async tagColorSet(
    workspaceRoot: string,
    tag: string,
    color: TagColor,
  ): Promise<void> {
    await this.execInWorkspace(workspaceRoot, [
      'tag', 'color', 'set', tag, color, '--format', 'json',
    ]);
  }

  public async tagColorRemove(workspaceRoot: string, tag: string): Promise<void> {
    await this.execInWorkspace(workspaceRoot, [
      'tag', 'color', 'remove', tag, '--format', 'json',
    ]);
  }

  private async execInWorkspaceWithStdin(
    workspaceRoot: string,
    args: string[],
    input: string,
  ): Promise<string> {
    const resolution = this.resolveCli();

    if (!resolution.cliPath) {
      this.logResolution(resolution);
      throw new Error(this.formatMissingCliMessage());
    }

    const resolvedCli = { ...resolution, cliPath: resolution.cliPath };
    const configuredVaultPath = this.dependencies.getConfiguredVaultPath?.();
    const commandArgs = configuredVaultPath
      ? ['--vault', configuredVaultPath, ...args]
      : args;

    await this.ensureCliCompatibility(workspaceRoot, resolvedCli);
    this.logResolution(resolvedCli, commandArgs);

    try {
      const result = await this.dependencies.spawnWithInput(resolvedCli.cliPath, commandArgs, {
        cwd: workspaceRoot,
        input,
      });
      return result.stdout.trim();
    } catch (error) {
      this.log('environment value command failed; output suppressed');
      throw this.formatSensitiveCommandError(error, resolvedCli);
    }
  }

  private async execInWorkspace(
    workspaceRoot: string,
    args: string[],
    signal?: AbortSignal,
    suppressOutput = false,
    onSpawn?: () => void,
  ): Promise<string> {
    const resolution = this.resolveCli();

    if (!resolution.cliPath) {
      this.logResolution(resolution);
      throw new Error(this.formatMissingCliMessage());
    }

    const resolvedCli = { ...resolution, cliPath: resolution.cliPath };
    const configuredVaultPath = this.dependencies.getConfiguredVaultPath?.();
    const commandArgs = configuredVaultPath
      ? ['--vault', configuredVaultPath, ...args]
      : args;

    await this.ensureCliCompatibility(workspaceRoot, resolvedCli);
    this.logResolution(resolvedCli, commandArgs);

    try {
      if (suppressOutput && args[0] === 'env' && args[1] === 'run') {
        await this.dependencies.runCommand(resolvedCli.cliPath, commandArgs, {
          cwd: workspaceRoot,
          signal,
          onSpawn,
        });
        return '';
      }

      const result = await this.dependencies.execFile(resolvedCli.cliPath, commandArgs, {
        cwd: workspaceRoot,
        signal,
      });

      if (!suppressOutput && result.stderr.trim().length > 0) {
        this.log(`stderr: ${result.stderr.trim()}`);
      }

      return result.stdout.trim();
    } catch (error) {
      if (suppressOutput) {
        this.log('environment run failed; child output suppressed');
        throw this.formatSensitiveCommandError(error, resolvedCli);
      }

      this.logExecutionError(error);
      throw this.formatCommandError(error, resolvedCli);
    }
  }

  private resolveCli(): CliResolution {
    const configuredCliPath =
      this.dependencies.getConfiguredCliPath?.() ?? getConfiguredCliPath();

    return resolveCliPath({
      configuredCliPath,
      extensionPath: this.dependencies.extensionPath,
      platform: this.dependencies.platform,
      arch: this.dependencies.arch,
      existsSync: this.dependencies.existsSync,
    });
  }

  private async ensureCliCompatibility(
    workspaceRoot: string,
    resolution: CliResolution & { cliPath: string },
  ): Promise<void> {
    let verification = this.verifiedCliPaths.get(resolution.cliPath);

    if (!verification) {
      verification = this.verifyCliCompatibility(workspaceRoot, resolution);
      this.verifiedCliPaths.set(resolution.cliPath, verification);
    }

    try {
      await verification;
    } catch (error) {
      this.verifiedCliPaths.delete(resolution.cliPath);
      throw error;
    }
  }

  private async verifyCliCompatibility(
    workspaceRoot: string,
    resolution: CliResolution & { cliPath: string },
  ): Promise<void> {
    await this.ensureExecutablePermission(resolution);

    try {
      const versionResult = await this.dependencies.execFile(resolution.cliPath, ['--version'], {
        cwd: workspaceRoot,
      });
      const stdout = versionResult.stdout.trim();
      const stderr = versionResult.stderr.trim();

      this.log(
        `version check: path=${resolution.cliPath} source=${resolution.source} stdout=${stdout || '<empty>'}`,
      );

      if (stderr.length > 0) {
        this.log(`version stderr: ${stderr}`);
      }

      const actualVersion = extractSemver(stdout);
      const expectedVersion = this.dependencies.extensionVersion;

      if (expectedVersion && actualVersion && actualVersion !== expectedVersion) {
        throw new Error(
          `FrilVault CLI version mismatch. Expected ${expectedVersion}, found ${actualVersion}.`,
        );
      }
    } catch (error) {
      this.logExecutionError(error);
      throw this.formatStartupError(error, resolution);
    }
  }

  private async ensureExecutablePermission(
    resolution: CliResolution & { cliPath: string },
  ): Promise<void> {
    if (this.dependencies.platform === 'win32') {
      return;
    }

    await this.dependencies.access(resolution.cliPath, fsConstants.X_OK).catch((error) => {
      throw this.formatStartupError(error, resolution);
    });
  }

  private formatMissingCliMessage(): string {
    return [
      'FrilVault CLI could not be started.',
      `No bundled CLI was found for ${this.dependencies.platform}-${this.dependencies.arch}.`,
      'Set `frilvault.cliPath` to a compatible executable or package the platform CLI into the VSIX.',
    ].join(' ');
  }

  private formatStartupError(
    error: unknown,
    resolution: CliResolution & { cliPath: string },
  ): Error {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.startsWith('FrilVault CLI version mismatch.')) {
      return new Error(message);
    }

    if (isMissingExecutableError(error)) {
      if (resolution.source === 'configured') {
        return new Error(
          `FrilVault CLI could not be started. The configured \`frilvault.cliPath\` could not be found: ${resolution.cliPath}.`,
        );
      }

      return new Error(this.formatMissingCliMessage());
    }

    if (isPermissionError(error)) {
      return new Error(
        `FrilVault CLI could not be started. The resolved executable is not runnable: ${resolution.cliPath}.`,
      );
    }

    return new Error(
      `FrilVault CLI could not be started. Check the "FrilVault CLI" output channel for details. (${message})`,
    );
  }

  private formatCommandError(
    error: unknown,
    resolution: CliResolution & { cliPath: string },
  ): Error {
    if (isSpawnFailure(error)) {
      return this.formatStartupError(error, resolution);
    }

    const stderr = readExecErrorStream(error, 'stderr');
    if (stderr) {
      return parseCliCommandError(stderr) ?? new Error(stderr);
    }

    const message =
      error instanceof Error ? error.message : 'Failed to execute FrilVault CLI.';

    return new Error(message);
  }

  private formatSensitiveCommandError(
    error: unknown,
    resolution: CliResolution & { cliPath: string },
  ): Error {
    if (isSpawnFailure(error)) {
      return this.formatStartupError(error, resolution);
    }

    return new Error(
      'FrilVault environment command failed. Output was suppressed to protect environment values.',
    );
  }

  private logResolution(resolution: CliResolution, args: string[] = []): void {
    this.log(
      [
        `platform=${this.dependencies.platform}`,
        `arch=${this.dependencies.arch}`,
        `source=${resolution.source}`,
        `path=${resolution.cliPath ?? '<missing>'}`,
        `args=${args.join(' ') || '<none>'}`,
      ].join(' '),
    );
  }

  private logExecutionError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = readExecErrorStream(error, 'stderr');
    const stdout = readExecErrorStream(error, 'stdout');

    this.log(`error: ${message}`);

    if (stdout) {
      this.log(`stdout: ${stdout}`);
    }

    if (stderr) {
      this.log(`stderr: ${stderr}`);
    }
  }

  private log(message: string): void {
    this.dependencies.outputChannel?.appendLine(`[FrilVault CLI] ${message}`);
  }
}

function parseCliCommandError(stderr: string): CliCommandError | undefined {
  try {
    const parsed = JSON.parse(stderr) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (
      typeof parsed.error?.code === 'string' &&
      typeof parsed.error.message === 'string'
    ) {
      return new CliCommandError(parsed.error.message, parsed.error.code);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractSemver(raw: string): string | undefined {
  return raw.match(VERSION_PATTERN)?.[1];
}

const spawnWithInput: SpawnWithInputLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(
        signal ? `FrilVault CLI terminated by ${signal}.` : `FrilVault CLI exited with code ${code}.`,
      ) as Error & { stdout: string; stderr: string };
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin?.end(options.input);
  });

const runCommandWithoutBuffer: RunCommandLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: 'ignore',
    });
    child.once('spawn', () => options.onSpawn?.());
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(
        signal ? `Environment child terminated by ${signal}.` : `Environment child exited with code ${code}.`,
      ));
    });
  });

function isSpawnFailure(error: unknown): boolean {
  return isMissingExecutableError(error) || isPermissionError(error);
}

function isMissingExecutableError(error: unknown): boolean {
  return readExecErrorCode(error) === 'ENOENT';
}

function isPermissionError(error: unknown): boolean {
  return readExecErrorCode(error) === 'EACCES';
}

function readExecErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  return 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function readExecErrorStream(
  error: unknown,
  key: 'stdout' | 'stderr',
): string | undefined {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }

  const value = (error as Record<'stdout' | 'stderr', unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
