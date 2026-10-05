/**
 * VS Code extension entry point for FrilVault.
 *
 * Activation wires CLI-backed commands, providers, decorators, and workspace
 * listeners. All note persistence goes through `CliClient`; the extension never
 * writes vault JSON directly.
 *
 * FrilVault VS Code extension 진입점입니다.
 *
 * activation 시 CLI 기반 command, provider, decorator, workspace listener를
 * 등록합니다. 모든 note 저장은 `CliClient`를 거치며 extension은 vault
 * JSON을 직접 쓰지 않습니다.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

import { CliClient } from './core/cliClient';
import { COMMAND_IDS, VIEW_IDS } from './constants/ids';
import { CurrentFileNotesStore } from './features/current-file/store';
import { isActiveEditorDocumentSave } from './features/current-file/saveRefresh';
import { createDisableCommand, createEnableCommand } from './features/enablement/command';
import { isFrilVaultEnabled, syncEnabledContext } from './features/enablement/state';
import { registerExplorerNoteCountDecorations } from './features/explorer-badges/provider';
import { WorkspaceNoteCountStore } from './features/explorer-badges/store';
import { FrilVaultDecorator } from './features/decorations/decorator';
import { GutterNoteActions } from './features/decorations/gutterActions';
import { registerGutterCommands } from './features/decorations/gutterCommands';
import { GutterNoteRegistry } from './features/decorations/registry';
import { SelectedNoteHighlighter } from './features/decorations/selectedNote';
import { FrilVaultHoverProvider } from './features/hover/hoverProvider';
import { registerFrilVaultHoverProvider } from './features/hover/register';
import {
  createAddOrEditNoteCommand,
  createAddNoteCommand,
  createEditNoteCommand,
} from './features/inline-editor/command';
import { createInlineNoteEditor } from './features/inline-editor/editor';
import { isEligibleSourceEditor } from './features/inline-editor/sourceContext';
import { NoteViewerController } from './features/note-viewer/noteViewerController';
import {
  createNoteViewerActionsCommand,
  createNoteViewerAddOrEditCommand,
  createNoteViewerDeleteCommand,
  createToggleNoteViewerCommand,
} from './features/note-viewer/noteViewerCommands';
import { createShowNotesForCurrentFileCommand } from './features/notes-panel/command';
import { FrilVaultNotesProvider } from './features/notes-panel/provider';
import { registerNotesTreeDataProvider, disposeNotesTreeDataProvider } from './features/notes-panel/register';
import {
  createSearchByTagCommand,
  createWorkspaceSearchCommand,
} from './features/search/command';
import { FrilVaultTagExplorerProvider } from './features/tag-explorer/provider';
import {
  createRemoveTagColorCommand,
  createSetTagColorCommand,
} from './features/tag-explorer/commands';
import { createApplyRepairsCommand, createShowHealthCommand } from './features/workspace/health';
import { registerSourceRenameHandler } from './features/workspace/rename';
import { registerNoteUriHandler } from './features/uri/handler';
import {
  registerWorkspaceWatcher,
  type WorkspaceWatcherHandle,
} from './features/workspace/watcher';
import { createRefreshDiagnosticLogger } from './features/refresh/diagnostics';
import { createShowStatsCommand } from './features/workspace/stats';
import {
  createAddEnvironmentVariableCommand,
  createImportEnvironmentCommand,
  createRefreshEnvironmentCommand,
  createReplaceEnvironmentValueCommand,
  createRunEnvironmentCommand,
} from './features/environment/commands';
import {
  FrilVaultEnvironmentProvider,
  type EnvironmentRuntimeState,
} from './features/environment/provider';
import type { NoteView } from './types';
import {
  getWorkspaceRoot,
  getVaultRoot,
  revealNote,
  tryGetVaultPath,
  tryGetWorkspaceRoot,
} from './utils/file';

let activeDecorator: FrilVaultDecorator | undefined;
let activeNoteCountStore: WorkspaceNoteCountStore | undefined;
let activeStore: CurrentFileNotesStore | undefined;
let activeRegistry: GutterNoteRegistry | undefined;
let activeNoteViewer: NoteViewerController | undefined;
let activeSelectedNote: SelectedNoteHighlighter | undefined;

export async function runBackgroundRefresh(
  refresh: () => Promise<void>,
  reportError: (message: string) => void,
): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    reportError(error instanceof Error ? error.message : 'Failed to refresh FrilVault views.');
  }
}

/**
 * Registers FrilVault commands, providers, and workspace listeners.
 *
 * Refresh happens when the active editor changes, a document is saved, note data
 * mutates, or the user explicitly refreshes. Disabled workspaces clear UI state
 * but keep enablement commands available.
 *
 * FrilVault command, provider, workspace listener를 등록합니다.
 */
export function activate(context: vscode.ExtensionContext): void {
  const cliOutputChannel = vscode.window.createOutputChannel('FrilVault CLI');
  const searchRefreshEmitter = new vscode.EventEmitter<void>();
  const cliClient = new CliClient({
    extensionPath: context.extensionPath,
    getConfiguredVaultPath: tryGetVaultPath,
    extensionVersion:
      (context.extension.packageJSON as { frilvaultBundledCliVersion?: string; version?: string })
        .frilvaultBundledCliVersion
      ?? context.extension.packageJSON.version,
    outputChannel: cliOutputChannel,
  });
  const refreshTrace = createRefreshDiagnosticLogger(cliOutputChannel);
  let environmentRuntimeState: EnvironmentRuntimeState = { status: 'unknown' };

  const isEnabled = () => {
    const workspaceRoot = tryGetWorkspaceRoot();

    if (!workspaceRoot) {
      return false;
    }

    return isFrilVaultEnabled(context.workspaceState, workspaceRoot);
  };

  const updateSourceEditorContext = () => {
    const eligible = isEligibleSourceEditor(vscode.window.activeTextEditor, (root) =>
      isFrilVaultEnabled(context.workspaceState, root));
    void vscode.commands.executeCommand('setContext', 'frilvault.sourceEditorEligible', eligible);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateSourceEditorContext),
    vscode.workspace.onDidChangeConfiguration(updateSourceEditorContext),
    vscode.workspace.onDidGrantWorkspaceTrust(updateSourceEditorContext),
  );
  updateSourceEditorContext();

  const store = new CurrentFileNotesStore(cliClient, isEnabled, tryGetWorkspaceRoot, refreshTrace);
  activeStore = store;

  const gutterRegistry = new GutterNoteRegistry();
  activeRegistry = gutterRegistry;

  const noteCountStore = new WorkspaceNoteCountStore(
    cliClient,
    getWorkspaceRoot,
    getVaultRoot,
    refreshTrace,
  );
  activeNoteCountStore = noteCountStore;

  const notesProvider = new FrilVaultNotesProvider(
    store,
    (workspaceContext) => cliClient.workspaceExplorer(workspaceContext.workspaceRoot),
    getWorkspaceRoot,
    isEnabled,
    context.workspaceState,
    () => {
      const workspaceRoot = tryGetWorkspaceRoot();
      return workspaceRoot
        ? { workspaceRoot, vaultRoot: getVaultRoot(workspaceRoot) }
        : undefined;
    },
    refreshTrace,
  );
  const tagExplorerProvider = new FrilVaultTagExplorerProvider(
    (tagContext) => cliClient.tagList(tagContext.workspaceRoot),
    (tag, tagContext) => cliClient.searchNotes({ workspaceRoot: tagContext.workspaceRoot, tag }),
    isEnabled,
    () => {
      const workspaceRoot = tryGetWorkspaceRoot();
      return workspaceRoot
        ? { workspaceRoot, vaultRoot: getVaultRoot(workspaceRoot) }
      : undefined;
    },
    refreshTrace,
  );
  const decorator = new FrilVaultDecorator(
    context.extensionPath,
    store,
    gutterRegistry,
    getWorkspaceRoot,
    isEnabled,
  );
  activeDecorator = decorator;
  const selectedNoteHighlighter = new SelectedNoteHighlighter(context.extensionPath);
  activeSelectedNote = selectedNoteHighlighter;
  const noteViewer = new NoteViewerController(store, isEnabled);
  activeNoteViewer = noteViewer;
  const hoverProvider = new FrilVaultHoverProvider(
    store,
    isEnabled,
  );

  const refreshNoteState = async (
    editor?: vscode.TextEditor,
    trigger = 'note-mutation',
  ) => {
    await store.invalidateAfterMutation(editor ?? vscode.window.activeTextEditor, trigger);
  };

  const refreshWorkspaceNoteCounts = async () => {
    if (!isEnabled()) {
      noteCountStore.clear();
      return;
    }

    try {
      await noteCountStore.reload();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load workspace note counts.';

      cliOutputChannel.appendLine(`FrilVault: ${message}`);
    }
  };

  const refreshAffectedViews = async (
    editor: vscode.TextEditor | undefined,
    refreshTagData: 'all' | 'notes',
    trigger: string,
  ) => {
    void notesProvider.invalidateWorkspaceOverview(trigger).catch((error: unknown) => {
      const message = error instanceof Error
        ? error.message
        : 'Failed to refresh the workspace Notes overview.';
      cliOutputChannel.appendLine(`FrilVault: ${message}`);
    });
    if (refreshTagData === 'all') {
      await tagExplorerProvider.refresh(trigger);
    } else {
      await tagExplorerProvider.refreshTaggedNotes();
    }
    await refreshNoteState(editor, trigger);
    await refreshWorkspaceNoteCounts();
    searchRefreshEmitter.fire();
  };

  const refreshAfterMutation = async (
    editor?: vscode.TextEditor,
    trigger = 'note-mutation',
  ) => {
    updateSourceEditorContext();
    await refreshAffectedViews(editor, 'all', trigger);
  };

  const refreshAfterInlineNoteChange = async (change = { tagsChanged: true }) => {
    await refreshAffectedViews(
      vscode.window.activeTextEditor,
      change.tagsChanged ? 'all' : 'notes',
      'note-save',
    );
  };

  const refreshCurrentFile = async (editor: vscode.TextEditor | undefined) => {
    if (!editor) {
      return;
    }

    await runBackgroundRefresh(
      async () => store.syncActiveEditor(editor),
      (message) => cliOutputChannel.appendLine(`FrilVault: ${message}`),
    );
  };

  const refreshCurrentFileAfterDocumentSave = async (document: vscode.TextDocument) => {
    const editor = vscode.window.activeTextEditor;

    if (!isActiveEditorDocumentSave(document, editor)) {
      return;
    }

    await runBackgroundRefresh(
      async () => store.invalidateAfterMutation(editor),
      (message) => cliOutputChannel.appendLine(`FrilVault: ${message}`),
    );
  };

  const inlineNoteEditor = createInlineNoteEditor({
    cliClient,
    resolveVaultPath: async (workspaceRoot) => {
      if (!vscode.workspace.isTrusted) {
        throw new Error('Trust this workspace before using FrilVault notes.');
      }
      if (!isFrilVaultEnabled(context.workspaceState, workspaceRoot)) {
        throw new Error('FrilVault is disabled for this workspace. Enable it from the FrilVault Notes view.');
      }
      const capturedClient = cliClient.withVaultPath(tryGetVaultPath());
      const status = await capturedClient.workspaceStatus(workspaceRoot);
      return status.vault_path;
    },
    refreshNoteState: refreshAfterInlineNoteChange,
    showWarningMessage: (message) => vscode.window.showWarningMessage(message),
  });
  inlineNoteEditor.register(context);

  const gutterActions = new GutterNoteActions({
    cliClient,
    registry: gutterRegistry,
    getWorkspaceRoot,
    invalidateViews: refreshAfterMutation,
    openInlineEditor: (noteView) => inlineNoteEditor.openEdit(noteView),
    prepareInlineEditor: () => inlineNoteEditor.prepareEdit(),
  });

  let environmentProvider: FrilVaultEnvironmentProvider | undefined;

  const clearUi = () => {
    updateSourceEditorContext();
    inlineNoteEditor.suspend();
    store.clear();
    noteCountStore.clear();
    gutterRegistry.clear();
    decorator.clear();
    noteViewer.clearAll();
    selectedNoteHighlighter.clear();
    notesProvider.clear();
    tagExplorerProvider.clear();
    environmentProvider?.refresh();
  };

  const discoverDotenv = async (): Promise<string[]> => {
    const workspaceRoot = getWorkspaceRoot();
    const files = await vscode.workspace.findFiles(
      '**/.env*',
      '**/{.git,.vault,node_modules}/**',
      100,
    );
    return files
      .filter((uri) => {
        const relative = vscode.workspace.asRelativePath(uri, false);
        const basename = relative.split(/[\\/]/).pop() ?? relative;
        return /^\.env(?:\..+)?$/.test(basename);
      })
      .map((uri) => uri.fsPath)
      .filter((filePath) => {
        const relative = path.relative(workspaceRoot, filePath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
  };

  environmentProvider = new FrilVaultEnvironmentProvider({
    cliClient,
    getWorkspaceRoot,
    isEnabled,
    discoverDotenv,
    getRuntimeState: () => environmentRuntimeState,
  });

  registerGutterCommands(context, gutterActions);

  const onStoreChanged = () => {
    notesProvider.refresh();
    void decorator.refresh();
    void noteViewer.refresh();
  };

  store.onDidChange(onStoreChanged, undefined, context.subscriptions);

  const runWhenEnabled = <T extends unknown[]>(
    handler: (...args: T) => void | Promise<void>,
  ) => {
    return async (...args: T) => {
      if (!isEnabled()) {
        void vscode.window.showInformationMessage(
          'FrilVault is disabled for this workspace. Turn it on from the FrilVault Notes view.',
        );
        return;
      }

      await handler(...args);
    };
  };

  const environmentCommandDependencies = {
    cliClient,
    getWorkspaceRoot,
    refresh: () => environmentProvider?.refresh(),
    setRuntimeState: (state: EnvironmentRuntimeState) => {
      environmentRuntimeState = state;
    },
    discoverDotenv,
    showErrorMessage: (message: string) => vscode.window.showErrorMessage(message),
    showInformationMessage: (message: string) => vscode.window.showInformationMessage(message),
    showWarningMessage: (message: string, ...items: string[]) =>
      vscode.window.showWarningMessage(message, ...items),
  };

  let refreshVaultWatchers: WorkspaceWatcherHandle = Object.assign(
    async () => undefined,
    { syncSourceChanges: (_trigger?: string) => undefined },
  );
  const enableCommand = createEnableCommand({
    getWorkspaceRoot,
    workspaceState: context.workspaceState,
    cliClient,
    onVaultResolved: () => refreshVaultWatchers(),
    refreshUi: async () => {
      inlineNoteEditor.resume();
      await refreshAfterMutation();
    },
    clearUi,
    showWarningMessage: (message, ...items) =>
      vscode.window.showWarningMessage(message, ...items),
    showErrorMessage: (message) => vscode.window.showErrorMessage(message),
  });

  context.subscriptions.push(
    cliOutputChannel,
    searchRefreshEmitter,
    tagExplorerProvider,
    store,
    noteCountStore,
    notesProvider,
    decorator,
    selectedNoteHighlighter,
    noteViewer,
    registerFrilVaultHoverProvider(context, hoverProvider),
    vscode.commands.registerCommand(COMMAND_IDS.notesPanelOpenNote, async (noteView: NoteView) => {
      if (!isEnabled()) {
        return;
      }

      selectedNoteHighlighter.clear();
      const target = await revealNote(noteView, getWorkspaceRoot());
      if (target) {
        selectedNoteHighlighter.select(target.editor.document.uri.toString(), target.line);
      } else {
        await vscode.window.showWarningMessage(
          `This note's source anchor no longer resolves. Use Edit Note to repair it.`,
        );
      }
    }),
    vscode.commands.registerCommand(
      COMMAND_IDS.enable,
      enableCommand,
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.disable,
      createDisableCommand({
        getWorkspaceRoot,
        workspaceState: context.workspaceState,
        cliClient,
        refreshUi: refreshAfterMutation,
        clearUi,
      }),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.addOrEditNote,
      createAddOrEditNoteCommand(inlineNoteEditor),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.addNote,
      createAddNoteCommand(inlineNoteEditor),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.editNote,
      createEditNoteCommand(inlineNoteEditor),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.noteViewerToggle,
      runWhenEnabled(createToggleNoteViewerCommand(noteViewer)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.noteViewerActions,
      runWhenEnabled(createNoteViewerActionsCommand(gutterActions)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.noteViewerAddOrEdit,
      runWhenEnabled(createNoteViewerAddOrEditCommand(inlineNoteEditor)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.noteViewerDelete,
      runWhenEnabled(createNoteViewerDeleteCommand(gutterActions)),
    ),
    vscode.commands.registerCommand(COMMAND_IDS.noteViewerNoop, () => undefined),
    vscode.commands.registerCommand(
      COMMAND_IDS.notesPanelEditNote,
      runWhenEnabled(async (item: { noteView?: NoteView }) => {
        if (!item?.noteView) {
          return;
        }

        await inlineNoteEditor.openEdit(item.noteView);
      }),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.searchNotes,
      runWhenEnabled(createWorkspaceSearchCommand({
        cliClient,
        getWorkspaceRoot,
        onDidChangeNotes: (listener) => searchRefreshEmitter.event(listener),
      })),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.searchNotesByTag,
      runWhenEnabled(createSearchByTagCommand({ cliClient, getWorkspaceRoot })),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.setTagColor,
      runWhenEnabled(createSetTagColorCommand({
        cliClient,
        getWorkspaceRoot,
        refresh: () => tagExplorerProvider.refreshTagSummaries(),
      })),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.removeTagColor,
      runWhenEnabled(createRemoveTagColorCommand({
        cliClient,
        getWorkspaceRoot,
        refresh: () => tagExplorerProvider.refreshTagSummaries(),
      })),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.showNotesForCurrentFile,
      runWhenEnabled(
        createShowNotesForCurrentFileCommand({
          store,
          refreshNotesPanel: () => notesProvider.refresh(),
          quickPick: {
            cliClient,
            getWorkspaceRoot,
            invalidateViews: refreshAfterMutation,
            openInlineEditor: (noteView) => inlineNoteEditor.openEdit(noteView),
            prepareInlineEditor: () => inlineNoteEditor.prepareEdit(),
          },
        }),
      ),
    ),
    vscode.commands.registerCommand(
      'frilvault.showStats',
      runWhenEnabled(createShowStatsCommand(cliClient, getWorkspaceRoot)),
    ),
    vscode.commands.registerCommand(
      'frilvault.showHealth',
      runWhenEnabled(createShowHealthCommand(cliClient, getWorkspaceRoot)),
    ),
    vscode.commands.registerCommand(
      'frilvault.applyRepairs',
      runWhenEnabled(createApplyRepairsCommand(cliClient, getWorkspaceRoot, refreshAfterMutation)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.refresh,
      runWhenEnabled(async () => {
        await refreshAfterMutation(undefined, 'manual-refresh');
      }),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.environmentAddVariable,
      runWhenEnabled(
        createAddEnvironmentVariableCommand(environmentCommandDependencies),
      ),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.environmentReplaceValue,
      runWhenEnabled(
        createReplaceEnvironmentValueCommand(environmentCommandDependencies),
      ),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.environmentImport,
      runWhenEnabled(
        createImportEnvironmentCommand(environmentCommandDependencies),
      ),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.environmentRun,
      runWhenEnabled(
        createRunEnvironmentCommand(environmentCommandDependencies),
      ),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.environmentRefresh,
      createRefreshEnvironmentCommand(() => environmentProvider?.refresh()),
    ),
    vscode.window.onDidChangeActiveTextEditor(refreshCurrentFile),
    vscode.workspace.onDidSaveTextDocument(refreshCurrentFileAfterDocumentSave),
  );

  registerNotesTreeDataProvider(context, notesProvider);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_IDS.tags, tagExplorerProvider),
  );
  if (environmentProvider) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(VIEW_IDS.environments, environmentProvider),
    );
  }

  refreshVaultWatchers = registerWorkspaceWatcher(
    context,
    cliClient,
    isEnabled,
    async () => refreshAfterMutation(undefined, 'workspace-sync'),
    { trace: refreshTrace },
  );
  registerSourceRenameHandler(context, isEnabled, refreshVaultWatchers.syncSourceChanges);
  registerNoteUriHandler(context, { cliClient, isEnabled });
  registerExplorerNoteCountDecorations(context, noteCountStore, getWorkspaceRoot, isEnabled);
  noteViewer.register(context);
  void syncEnabledContext(isEnabled()).then(async () => {
    try {
      if (isEnabled()) {
        await enableCommand();
        if (isEnabled()) {
          await refreshAfterMutation();
        }
        return;
      }

      clearUi();
    } catch {
      clearUi();
    }
  });
}

/**
 * Clears in-memory UI state when the extension deactivates.
 *
 * extension 비활성화 시 in-memory UI state를 정리합니다.
 */
export function deactivate(): void {
  disposeNotesTreeDataProvider();
  activeDecorator?.clear();
  activeNoteViewer?.clearAll();
  activeSelectedNote?.clear();
  activeStore?.clear();
  activeNoteCountStore?.clear();
  activeRegistry?.clear();
  activeDecorator = undefined;
  activeNoteViewer = undefined;
  activeSelectedNote = undefined;
  activeStore = undefined;
  activeNoteCountStore = undefined;
  activeRegistry = undefined;
}
