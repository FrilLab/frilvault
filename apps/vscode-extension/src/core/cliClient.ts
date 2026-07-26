import { constants as fsConstants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  NoteView,
  RepairSuggestion,
  SyncResult,
  WorkspaceExplorer,
  WorkspaceHealth,
  WorkspaceIndex,
  WorkspaceStats,
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
  },
) => Promise<ExecFileResult>;

export interface OutputChannelLike {
  appendLine(value: string): void;
}

export interface CliClientDependencies {
  getConfiguredCliPath?: () => string;
  extensionPath?: string;
  extensionVersion?: string;
  outputChannel?: OutputChannelLike;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  execFile?: ExecFileLike;
  access?: (path: string, mode: number) => Promise<void>;
  existsSync?: (path: string) => boolean;
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
  expectedUpdatedAt?: string;
}

export interface SearchNotesInput {
  workspaceRoot: string;
  keyword?: string;
  sourceFile?: string;
}

/**
 * Executes FrilVault CLI commands on behalf of the extension.
 *
 * Each method resolves the CLI path, validates compatibility, runs the
 * command in the workspace root, and parses JSON responses into typed DTOs.
 */
export class CliClient {
  private readonly dependencies: Required<
    Pick<CliClientDependencies, 'platform' | 'arch' | 'execFile' | 'access' | 'existsSync'>
  > &
    Omit<CliClientDependencies, 'platform' | 'arch' | 'execFile' | 'access' | 'existsSync'>;
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
      extensionPath: normalized.extensionPath,
      extensionVersion: normalized.extensionVersion,
      outputChannel: normalized.outputChannel,
      platform: normalized.platform ?? process.platform,
      arch: normalized.arch ?? process.arch,
      execFile: normalized.execFile ?? execFileAsync,
      access: normalized.access ?? access,
      existsSync: normalized.existsSync ?? existsSync,
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

    args.push('--format', 'json');

    const stdout = await this.execInWorkspace(input.workspaceRoot, args);

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

    for (const tag of input.tags ?? []) {
      args.push('--tag', tag);
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

  private async execInWorkspace(workspaceRoot: string, args: string[]): Promise<string> {
    const resolution = this.resolveCli();

    if (!resolution.cliPath) {
      this.logResolution(resolution);
      throw new Error(this.formatMissingCliMessage());
    }

    const resolvedCli = { ...resolution, cliPath: resolution.cliPath };

    await this.ensureCliCompatibility(workspaceRoot, resolvedCli);
    this.logResolution(resolvedCli, args);

    try {
      const result = await this.dependencies.execFile(resolvedCli.cliPath, args, {
        cwd: workspaceRoot,
      });

      if (result.stderr.trim().length > 0) {
        this.log(`stderr: ${result.stderr.trim()}`);
      }

      return result.stdout.trim();
    } catch (error) {
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
      return new Error(stderr);
    }

    const message =
      error instanceof Error ? error.message : 'Failed to execute FrilVault CLI.';

    return new Error(message);
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

function extractSemver(raw: string): string | undefined {
  return raw.match(VERSION_PATTERN)?.[1];
}

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
