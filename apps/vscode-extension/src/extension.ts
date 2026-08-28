/**
 * VS Code extension entry point for FrilVault.
 *
 * Activation wires CLI-backed commands, providers, decorators, and workspace
 * listeners. All note persistence goes through `CliClient`; the extension never
 * writes `.vault` JSON directly.
 *
 * FrilVault VS Code extension 진입점입니다.
 *
 * activation 시 CLI 기반 command, provider, decorator, workspace listener를
 * 등록합니다. 모든 note 저장은 `CliClient`를 거치며 extension은 `.vault`
 * JSON을 직접 쓰지 않습니다.
 */
import * as vscode from 'vscode';

import { CliClient } from './core/cliClient';
import { COMMAND_IDS, VIEW_IDS } from './constants/ids';
import { CurrentFileNotesStore } from './features/current-file/store';
import { createDisableCommand, createEnableCommand } from './features/enablement/command';
import { isFrilVaultEnabled, syncEnabledContext } from './features/enablement/state';
import { runOptionalPostSaveTasks } from './features/post-save/tasks';
import { registerExplorerNoteCountDecorations } from './features/explorer-badges/provider';
import { WorkspaceNoteCountStore } from './features/explorer-badges/store';
import { FrilVaultDecorator } from './features/decorations/decorator';
import { GutterNoteActions } from './features/decorations/gutterActions';
import { registerGutterCommands } from './features/decorations/gutterCommands';
import { GutterNoteRegistry } from './features/decorations/registry';
import { FrilVaultHoverProvider } from './features/hover/hoverProvider';
import { registerFrilVaultHoverProvider } from './features/hover/register';
import { registerInlineNoteCodeLensProvider } from './features/inline-editor/codelens';
import {
  createAddNoteCommand,
  createEditNoteCommand,
} from './features/inline-editor/command';
import { createInlineNoteEditor } from './features/inline-editor/editor';
import { NoteViewerController } from './features/note-viewer/noteViewerController';
import {
  createNoteViewerActionsCommand,
  createToggleNoteViewerCommand,
} from './features/note-viewer/noteViewerCommands';
import { createShowNotesForCurrentFileCommand } from './features/notes-panel/command';
import { FrilVaultNotesProvider } from './features/notes-panel/provider';
import { registerNotesTreeDataProvider, disposeNotesTreeDataProvider } from './features/notes-panel/register';
import { createSearchByTagCommand, createSearchCommand } from './features/search/command';
import { FrilVaultTagExplorerProvider } from './features/tag-explorer/provider';
import {
  createRemoveTagColorCommand,
  createSetTagColorCommand,
} from './features/tag-explorer/commands';
import { TagColorStore } from './features/presentation/tagColor';
import { createApplyRepairsCommand, createShowHealthCommand } from './features/workspace/health';
import { registerSourceRenameHandler } from './features/workspace/rename';
import { registerNoteUriHandler } from './features/uri/handler';
import { registerWorkspaceWatcher } from './features/workspace/watcher';
import { createShowStatsCommand } from './features/workspace/stats';
import type { NoteView } from './types';
import { getWorkspaceRoot, revealNote, tryGetWorkspaceRoot } from './utils/file';

let activeDecorator: FrilVaultDecorator | undefined;
let activeNoteCountStore: WorkspaceNoteCountStore | undefined;
let activeStore: CurrentFileNotesStore | undefined;
let activeRegistry: GutterNoteRegistry | undefined;
let activeNoteViewer: NoteViewerController | undefined;
const codeLensRefreshEmitter = new vscode.EventEmitter<void>();

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
  const cliClient = new CliClient({
    extensionPath: context.extensionPath,
    extensionVersion:
      (context.extension.packageJSON as { frilvaultBundledCliVersion?: string; version?: string })
        .frilvaultBundledCliVersion
      ?? context.extension.packageJSON.version,
    outputChannel: cliOutputChannel,
  });

  const isEnabled = () => {
    const workspaceRoot = tryGetWorkspaceRoot();

    if (!workspaceRoot) {
      return false;
    }

    return isFrilVaultEnabled(context.workspaceState, workspaceRoot);
  };

  const store = new CurrentFileNotesStore(cliClient, isEnabled);
  activeStore = store;

  const gutterRegistry = new GutterNoteRegistry();
  activeRegistry = gutterRegistry;

  const noteCountStore = new WorkspaceNoteCountStore(cliClient, getWorkspaceRoot);
  activeNoteCountStore = noteCountStore;

  const notesProvider = new FrilVaultNotesProvider(
    store,
    () => cliClient.workspaceExplorer(getWorkspaceRoot()),
    getWorkspaceRoot,
    isEnabled,
  );
  const tagColorStore = new TagColorStore(() => cliClient.tagList(getWorkspaceRoot()));
  const tagExplorerProvider = new FrilVaultTagExplorerProvider(
    () => tagColorStore.load(),
    (tag) => cliClient.searchNotes({ workspaceRoot: getWorkspaceRoot(), tag }),
    isEnabled,
  );
  const decorator = new FrilVaultDecorator(
    context.extensionPath,
    store,
    gutterRegistry,
    getWorkspaceRoot,
    isEnabled,
  );
  activeDecorator = decorator;
  const noteViewer = new NoteViewerController(store, isEnabled);
  activeNoteViewer = noteViewer;
  const hoverProvider = new FrilVaultHoverProvider(
    store,
    getWorkspaceRoot,
    isEnabled,
    (tag) => tagColorStore.colorFor(tag),
  );

  const refreshNoteState = async (editor?: vscode.TextEditor) => {
    await store.syncActiveEditor(editor ?? vscode.window.activeTextEditor);
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

  const refreshAfterMutation = async (editor?: vscode.TextEditor) => {
    tagColorStore.refresh();
    tagExplorerProvider.refresh();
    await tagColorStore.load();
    await refreshNoteState(editor);
    await refreshWorkspaceNoteCounts();
  };

  const inlineNoteEditor = createInlineNoteEditor({
    cliClient,
    getWorkspaceRoot,
    refreshNoteState: () => refreshAfterMutation(),
    runOptionalPostSaveTasks: () =>
      runOptionalPostSaveTasks({
        getWorkspaceRoot,
        cliClient,
      }),
    showWarningMessage: (message) => vscode.window.showWarningMessage(message),
  });
  inlineNoteEditor.register(context);

  const gutterActions = new GutterNoteActions({
    cliClient,
    registry: gutterRegistry,
    getWorkspaceRoot,
    invalidateViews: refreshAfterMutation,
    openInlineEditor: (noteView) => inlineNoteEditor.openEdit(noteView),
  });

  const clearUi = () => {
    store.clear();
    noteCountStore.clear();
    gutterRegistry.clear();
    decorator.clear();
    noteViewer.clearAll();
    notesProvider.refresh();
    tagExplorerProvider.refresh();
  };

  const refreshAfterWorkspaceEvent = async (editor?: vscode.TextEditor) => {
    await runBackgroundRefresh(
      async () => {
        if (!isEnabled()) {
          clearUi();
          return;
        }

        await refreshAfterMutation(editor);
      },
      (message) => cliOutputChannel.appendLine(`FrilVault: ${message}`),
    );
  };

  registerGutterCommands(context, gutterActions);

  const onStoreChanged = () => {
    notesProvider.refresh();
    void decorator.refresh();
    void noteViewer.refresh();
    codeLensRefreshEmitter.fire();
  };

  store.onDidChange(onStoreChanged, undefined, context.subscriptions);
  noteCountStore.onDidChange(onStoreChanged, undefined, context.subscriptions);

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

  context.subscriptions.push(
    cliOutputChannel,
    store,
    noteCountStore,
    decorator,
    noteViewer,
    registerFrilVaultHoverProvider(context, hoverProvider),
    vscode.commands.registerCommand(COMMAND_IDS.notesPanelOpenNote, async (noteView: NoteView) => {
      if (!isEnabled()) {
        return;
      }

      await revealNote(noteView, getWorkspaceRoot());
    }),
    vscode.commands.registerCommand(
      COMMAND_IDS.enable,
      createEnableCommand({
        getWorkspaceRoot,
        workspaceState: context.workspaceState,
        refreshUi: refreshAfterMutation,
        clearUi,
      }),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.disable,
      createDisableCommand({
        getWorkspaceRoot,
        workspaceState: context.workspaceState,
        refreshUi: refreshAfterMutation,
        clearUi,
      }),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.addNote,
      runWhenEnabled(createAddNoteCommand(inlineNoteEditor)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.editNote,
      runWhenEnabled(createEditNoteCommand(inlineNoteEditor)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.noteViewerToggle,
      runWhenEnabled(createToggleNoteViewerCommand(noteViewer)),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.noteViewerActions,
      runWhenEnabled(createNoteViewerActionsCommand(gutterActions)),
    ),
    vscode.commands.registerCommand(COMMAND_IDS.noteViewerNoop, () => undefined),
    vscode.commands.registerCommand(
      COMMAND_IDS.notesPanelEditNote,
      runWhenEnabled((item: { noteView?: NoteView }) => {
        if (!item?.noteView) {
          return;
        }

        inlineNoteEditor.openEdit(item.noteView);
      }),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.searchNotes,
      runWhenEnabled(createSearchCommand(cliClient, getWorkspaceRoot)),
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
        refresh: refreshAfterMutation,
      })),
    ),
    vscode.commands.registerCommand(
      COMMAND_IDS.removeTagColor,
      runWhenEnabled(createRemoveTagColorCommand({
        cliClient,
        getWorkspaceRoot,
        refresh: refreshAfterMutation,
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
        await refreshAfterMutation();
      }),
    ),
    vscode.window.onDidChangeActiveTextEditor(refreshAfterWorkspaceEvent),
    vscode.workspace.onDidSaveTextDocument(() => refreshAfterWorkspaceEvent()),
  );

  registerNotesTreeDataProvider(context, notesProvider);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_IDS.tags, tagExplorerProvider),
  );

  registerSourceRenameHandler(context, cliClient, isEnabled, refreshAfterMutation);
  registerWorkspaceWatcher(context, cliClient, isEnabled, refreshAfterMutation);
  registerNoteUriHandler(context, { cliClient, isEnabled });
  registerExplorerNoteCountDecorations(context, noteCountStore, getWorkspaceRoot, isEnabled);
  noteViewer.register(context);
  registerInlineNoteCodeLensProvider(
    context,
    store,
    getWorkspaceRoot,
    isEnabled,
    codeLensRefreshEmitter.event,
  );

  void syncEnabledContext(isEnabled()).then(async () => {
    try {
      if (isEnabled()) {
        await refreshAfterMutation();
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
  activeStore?.clear();
  activeNoteCountStore?.clear();
  activeRegistry?.clear();
  activeDecorator = undefined;
  activeNoteViewer = undefined;
  activeStore = undefined;
  activeNoteCountStore = undefined;
  activeRegistry = undefined;
}
