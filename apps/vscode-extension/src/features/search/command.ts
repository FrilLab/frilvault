import * as vscode from 'vscode';

import type { CliClient, SearchNotesInput } from '../../core/cliClient';
import type { NoteView } from '../../types';
import { revealNote } from '../../utils/file';
import {
  formatNoteQuickPickDescription,
  noteQuickPickLabel,
  truncateNoteContent,
} from '../notes-panel/presentation';
import { formatTagList } from '../presentation/tagPresentation';

const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_PREVIEW_LENGTH = 96;

export type SearchQuickPickItem = vscode.QuickPickItem & {
  note?: NoteView;
};

export interface ParsedSearchQuery {
  keyword?: string;
  sourceFile?: string;
  tags: string[];
  symbol?: string;
  error?: string;
}

export interface SearchCommandDependencies {
  cliClient: Pick<CliClient, 'searchNotes'>;
  getWorkspaceRoot: () => string;
  createQuickPick?: () => vscode.QuickPick<SearchQuickPickItem>;
  revealNote?: (note: NoteView, workspaceRoot: string) => Promise<void>;
  highlightNote?: (note: NoteView) => void;
  onDidChangeNotes?: (listener: () => void) => vscode.Disposable;
  debounceMs?: number;
}

export interface SearchByTagCommandDependencies {
  cliClient: Pick<CliClient, 'searchNotes'>;
  getWorkspaceRoot: () => string;
  showInputBox?: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  showInformationMessage?: (message: string) => Thenable<unknown>;
  showQuickPick?: (
    items: SearchQuickPickItem[],
    options: vscode.QuickPickOptions,
  ) => Thenable<SearchQuickPickItem | undefined>;
  revealNote?: (note: NoteView, workspaceRoot: string) => Promise<void>;
}

/**
 * Parses the small, extensible search language used by the native Quick Pick.
 * Plain terms search note content and symbol names. Filter values may be quoted.
 */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  const tokens = tokenizeSearchInput(input);

  if (tokens.error) {
    return { tags: [], error: tokens.error };
  }

  const keywords: string[] = [];
  const tags: string[] = [];
  let sourceFile: string | undefined;
  let symbol: string | undefined;

  for (const token of tokens.values) {
    const separator = token.indexOf(':');

    if (separator <= 0) {
      keywords.push(token);
      continue;
    }

    const operator = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1).trim();

    if (!value) {
      return {
        tags: [],
        error: `${operator} filter requires a value.`,
      };
    }

    switch (operator) {
      case 'tag':
        tags.push(value);
        break;
      case 'file':
        sourceFile = value;
        break;
      case 'symbol':
        symbol = value;
        break;
      default:
        return {
          tags: [],
          error: `Unknown search filter "${operator}:". Use tag:, file:, or symbol:.`,
        };
    }
  }

  return {
    keyword: keywords.length > 0 ? keywords.join(' ') : undefined,
    sourceFile,
    tags,
    symbol,
  };
}

function tokenizeSearchInput(input: string): { values: string[]; error?: string } {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  let escaped = false;

  const flush = (): void => {
    if (value.length > 0) {
      values.push(value);
      value = '';
    }
  };

  for (const character of input.trim()) {
    if (escaped) {
      value += character === '"' || character === '\\'
        ? character
        : `\\${character}`;
      escaped = false;
    } else if (character === '\\' && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (/\s/.test(character) && !quoted) {
      flush();
    } else {
      value += character;
    }
  }

  if (escaped) {
    value += '\\';
  }

  if (quoted) {
    return { values: [], error: 'Search query contains an unterminated quote.' };
  }

  flush();
  return { values };
}

export function createSearchCommand(
  cliClient: CliClient,
  getWorkspaceRoot: () => string,
): () => Promise<void> {
  return createWorkspaceSearchCommand({ cliClient, getWorkspaceRoot });
}

/** Opens the default, editor-preserving native search experience. */
export function createWorkspaceSearchCommand(
  dependencies: SearchCommandDependencies,
): () => Promise<void> {
  return async () => {
    const createQuickPick =
      dependencies.createQuickPick ??
      (() => vscode.window.createQuickPick<SearchQuickPickItem>());
    const quickPick = createQuickPick();
    const debounceMs = dependencies.debounceMs ?? SEARCH_DEBOUNCE_MS;
    let debounceTimer: NodeJS.Timeout | undefined;
    let requestVersion = 0;
    let controller: AbortController | undefined;
    let active = true;

    quickPick.title = 'FrilVault Search';
    quickPick.placeholder =
      'Search notes: parser, tag:todo, file:src/parser.rs, symbol:parse_config';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.items = [searchHelpItem()];

    const search = async (value: string): Promise<void> => {
      const version = ++requestVersion;
      controller?.abort();
      controller = undefined;

      const parsed = parseSearchQuery(value);

      if (parsed.error) {
        quickPick.title = `FrilVault Search — ${parsed.error}`;
        quickPick.busy = false;
        quickPick.items = [statusItem(parsed.error)];
        return;
      }

      quickPick.title = 'FrilVault Search';

      if (!value.trim()) {
        quickPick.busy = false;
        quickPick.items = [searchHelpItem()];
        return;
      }

      const nextController = new AbortController();
      controller = nextController;
      quickPick.busy = true;

      try {
        const results = await dependencies.cliClient.searchNotes({
          workspaceRoot: dependencies.getWorkspaceRoot(),
          ...toSearchInput(parsed),
          signal: nextController.signal,
        });

        if (!active || version !== requestVersion) {
          return;
        }

        quickPick.items = results.length > 0
          ? buildSearchQuickPickItems(results)
          : [statusItem(`No FrilVault notes found for "${value.trim()}".`)];
      } catch (error) {
        if (!active || version !== requestVersion || nextController.signal.aborted) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Failed to search notes.';
        quickPick.items = [statusItem(`Search failed: ${message}`)];
        quickPick.title = `FrilVault Search — ${message}`;
      } finally {
        if (active && version === requestVersion) {
          quickPick.busy = false;
        }
      }
    };

    const scheduleSearch = (value: string, immediate = false): void => {
      requestVersion += 1;
      controller?.abort();
      controller = undefined;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      if (immediate) {
        void search(value);
        return;
      }

      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void search(value);
      }, debounceMs);
    };

    quickPick.onDidChangeValue((value) => scheduleSearch(value));
    quickPick.onDidAccept(async () => {
      const picked = quickPick.selectedItems[0];

      if (!picked?.note) {
        return;
      }

      const note = picked.note;
      quickPick.hide();
      await (dependencies.revealNote ?? revealNote)(note, dependencies.getWorkspaceRoot());
      (dependencies.highlightNote ?? highlightSearchResult)(note);
    });

    const notesChanged = dependencies.onDidChangeNotes?.(() => {
      if (quickPick.value.trim()) {
        scheduleSearch(quickPick.value, true);
      }
    });

    await new Promise<void>((resolve) => {
      quickPick.onDidHide(() => {
        active = false;
        requestVersion += 1;
        controller?.abort();
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        notesChanged?.dispose();
        quickPick.dispose();
        resolve();
      });

      quickPick.show();
    });
  };
}

function toSearchInput(query: ParsedSearchQuery): Omit<SearchNotesInput, 'workspaceRoot' | 'signal'> {
  return {
    ...(query.keyword ? { keyword: query.keyword } : {}),
    ...(query.sourceFile ? { sourceFile: query.sourceFile } : {}),
    ...(query.tags.length > 0 ? { tags: query.tags } : {}),
    ...(query.symbol ? { symbol: query.symbol } : {}),
  };
}

function searchHelpItem(): SearchQuickPickItem {
  return {
    label: '$(note) Search FrilVault notes',
    description: 'Type to search note content, tags, files, or symbols.',
    detail: 'Examples: tag:todo  file:src/parser.rs  symbol:parse_config',
  };
}

function statusItem(message: string): SearchQuickPickItem {
  return {
    label: `FrilVault search status: ${message}`,
    alwaysShow: true,
  };
}

export function buildSearchQuickPickItems(results: NoteView[]): SearchQuickPickItem[] {
  return results.map((note) => {
    const title = note.note.title?.trim()
      ? truncateNoteContent(note.note.title.trim(), 80)
      : noteQuickPickLabel(note);
    const anchor = formatSearchAnchor(note);
    const tags = formatTagList(note.note.tags);
    const preview = noteQuickPickLabel({
      ...note,
      note: { ...note.note, content: note.note.content.slice(0, SEARCH_PREVIEW_LENGTH) },
    });

    return {
      label: `$(note) FrilVault note: ${title}`,
      description: `${note.source_file} · ${anchor}`,
      detail: tags ? `${tags} · ${preview}` : preview,
      alwaysShow: true,
      note,
    };
  });
}

function formatSearchAnchor(note: NoteView): string {
  if (note.note.anchor.type === 'Line') {
    return `Line ${note.note.anchor.line ?? 1}`;
  }

  const name = note.note.anchor.name ?? 'Symbol';
  return note.resolved
    ? `Line ${note.resolved.line} · Symbol ${name}`
    : `Unresolved symbol · ${name}`;
}

export function getSearchHighlightLine(note: NoteView): number | undefined {
  if (note.note.anchor.type === 'Line') {
    return (note.note.anchor.line ?? 1) - 1;
  }

  return note.resolved ? note.resolved.line - 1 : undefined;
}

function highlightSearchResult(note: NoteView): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const line = getSearchHighlightLine(note);
  if (line === undefined) {
    return;
  }

  const lineIndex = Math.min(Math.max(line, 0), Math.max(editor.document.lineCount - 1, 0));
  const lineText = editor.document.lineAt(lineIndex);
  const decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });

  editor.setDecorations(decoration, [lineText.range]);
  const timer = setTimeout(() => {
    editor.setDecorations(decoration, []);
    decoration.dispose();
  }, 1200);
  timer.unref?.();
}

export function createSearchByTagCommand(
  dependencies: SearchByTagCommandDependencies,
): (selectedTag?: string) => Promise<void> {
  return async (selectedTag?: string) => {
    const showInputBox = dependencies.showInputBox ?? vscode.window.showInputBox;
    const tag = selectedTag ?? await showInputBox({
      prompt: 'Search FrilVault notes by tag query',
      placeHolder: 'tag:performance AND NOT tag:legacy',
      ignoreFocusOut: true,
    });

    if (!tag || tag.trim().length === 0) {
      return;
    }

    const normalizedInput = tag.trim();
    const workspaceRoot = dependencies.getWorkspaceRoot();
    const results = await dependencies.cliClient.searchNotes({
      workspaceRoot,
      ...(selectedTag ? { tag: normalizedInput } : { tagQuery: normalizedInput }),
    });

    if (results.length === 0) {
      const showInformationMessage =
        dependencies.showInformationMessage ?? vscode.window.showInformationMessage;
      await showInformationMessage(`No notes found for tag query "${normalizedInput}".`);
      return;
    }

    const showQuickPick = dependencies.showQuickPick ?? vscode.window.showQuickPick;
    const picked = await showQuickPick(
      buildTagSearchQuickPickItems(results),
      { placeHolder: `Found ${results.length} note(s) for "${normalizedInput}"` },
    );

    if (picked?.note) {
      await (dependencies.revealNote ?? revealNote)(picked.note, workspaceRoot);
    }
  };
}

export function buildTagSearchQuickPickItems(results: NoteView[]): SearchQuickPickItem[] {
  return results.map((note) => {
    const tags = formatTagList(note.note.tags);

    return {
      label: noteQuickPickLabel(note),
      description: `${note.source_file} · ${formatNoteQuickPickDescription(note)}`,
      detail: tags ? `Tags: ${tags}` : undefined,
      note,
    };
  });
}
