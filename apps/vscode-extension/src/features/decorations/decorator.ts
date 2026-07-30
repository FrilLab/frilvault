import * as vscode from 'vscode';

import type { NoteView } from '../../types';
import {
  resolveNoteLine,
  resolveNoteRange,
} from '../presentation/editorNoteView';
import { aggregateNotesByLine } from './aggregate';
import { createSymbolNoteDecorationType } from './gutter';
import {
  createMarkerDecorationType,
  getConfiguredMarkerStyle,
  markerRenderOptions,
  type GutterMarkerStyle,
} from './markerStyle';
import type { GutterNoteRegistry } from './registry';
import {
  getNoteViewerMaxPreviewLines,
  getNoteViewerDefaultState,
  isNoteViewerEnabled,
} from '../note-viewer/config';
import { buildNoteViewerModel } from '../note-viewer/model';
import type { NoteViewerState } from '../note-viewer/state';

export class FrilVaultDecorator implements vscode.Disposable {
  private gutterDecorationType: vscode.TextEditorDecorationType;

  private noteViewerDecorationType: vscode.TextEditorDecorationType;

  private symbolDecorationType: vscode.TextEditorDecorationType;

  private markerStyle: GutterMarkerStyle;

  private previousEditor: vscode.TextEditor | undefined;

  private pendingEditorUri: string | undefined;

  private readonly configListener: vscode.Disposable;

  public constructor(
    private readonly extensionPath: string,
    private readonly store: import('../current-file/store').CurrentFileNotesStore,
    private readonly registry: GutterNoteRegistry,
    private readonly getWorkspaceRoot: () => string,
    private readonly noteViewerState: NoteViewerState,
    private readonly isEnabled: () => boolean = () => true,
  ) {
    this.markerStyle = getConfiguredMarkerStyle();
    this.gutterDecorationType = createMarkerDecorationType(this.extensionPath, this.markerStyle);
    this.noteViewerDecorationType = vscode.window.createTextEditorDecorationType({
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 0',
      },
    });
    this.symbolDecorationType = createSymbolNoteDecorationType(this.extensionPath);
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('frilvault.gutterMarkerStyle') &&
        !event.affectsConfiguration('frilvault.noteViewer')
      ) {
        return;
      }

      if (event.affectsConfiguration('frilvault.gutterMarkerStyle')) {
        this.recreateGutterDecorationType();
      }

      void this.refresh();
    });
  }

  public async refresh(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!this.isEnabled()) {
      this.clear(editor);
      this.previousEditor = editor;
      this.pendingEditorUri = undefined;
      this.registry.clear(editor?.document.uri.toString());
      return;
    }

    if (this.previousEditor && this.previousEditor !== editor) {
      this.clear(this.previousEditor);
      this.registry.clear(this.previousEditor.document.uri.toString());
    }

    if (!editor || editor.document.uri.scheme !== 'file') {
      this.previousEditor = editor;
      this.pendingEditorUri = undefined;
      return;
    }

    const editorUri = editor.document.uri.toString();
    this.pendingEditorUri = editorUri;

    const snapshot = this.store.getSnapshot();
    if (snapshot.loading || snapshot.editorDocumentUri !== editorUri) {
      this.clear(editor);
      return;
    }

    this.renderNotes(editor, snapshot.notes, snapshot.sourceFile ?? '');
  }

  public clear(editor = vscode.window.activeTextEditor): void {
    editor?.setDecorations(this.gutterDecorationType, []);
    editor?.setDecorations(this.noteViewerDecorationType, []);
    editor?.setDecorations(this.symbolDecorationType, []);
  }

  public dispose(): void {
    this.configListener.dispose();
    this.gutterDecorationType.dispose();
    this.noteViewerDecorationType.dispose();
    this.symbolDecorationType.dispose();
  }

  private renderNotes(
    editor: vscode.TextEditor,
    notes: NoteView[],
    _sourceFile: string,
  ): void {
    if (this.pendingEditorUri !== editor.document.uri.toString()) {
      return;
    }

    const groups = aggregateNotesByLine(notes, editor.document.lineCount);
    const lineNotes = new Map<number, NoteView[]>();
    const gutterDecorations: vscode.DecorationOptions[] = groups.map((group) => {
      lineNotes.set(group.line, group.notes);

      return {
        range: editor.document.lineAt(group.line).range,
        renderOptions: markerRenderOptions(this.markerStyle, group.notes.length),
      };
    });

    this.registry.set(editor.document.uri.toString(), lineNotes);
    editor.setDecorations(this.gutterDecorationType, gutterDecorations);
    editor.setDecorations(this.noteViewerDecorationType, this.buildNoteViewerDecorations(editor, notes));
    editor.setDecorations(
      this.symbolDecorationType,
      this.buildSymbolGutterDecorations(editor, notes),
    );
    this.previousEditor = editor;
    this.pendingEditorUri = undefined;
  }

  private buildNoteViewerDecorations(
    editor: vscode.TextEditor,
    notes: NoteView[],
  ): vscode.DecorationOptions[] {
    if (!isNoteViewerEnabled()) {
      return [];
    }

    const documentUri = editor.document.uri.toString();
    const defaultState = getNoteViewerDefaultState();
    const blocks = buildNoteViewerModel(notes, editor.document.lineCount, {
      defaultExpanded: defaultState === 'expanded',
      isExpanded: (groupId) => this.noteViewerState.isExpanded(documentUri, groupId, defaultState),
      maxPreviewLines: getNoteViewerMaxPreviewLines(),
    });

    return blocks.map((block) => ({
      range: lineDecorationRange(editor.document, block.group.line),
      hoverMessage: buildBlockHoverMessage(
        block.group.line,
        block.group.notes[0]?.source_file ?? '',
      ),
      renderOptions: {
        before: {
          contentText: `${block.expanded ? block.expandedText : block.collapsedText}\n`,
          color: new vscode.ThemeColor(
            block.expanded ? 'editorCodeLens.foreground' : 'editorInfo.foreground',
          ),
        },
      },
    }));
  }

  private buildSymbolGutterDecorations(
    editor: vscode.TextEditor,
    notes: NoteView[],
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];

    for (const note of notes) {
      if (note.note.anchor.type !== 'Symbol' || !note.resolved) {
        continue;
      }

      const range = resolveNoteRange(note, editor.document.lineCount);

      if (!range) {
        continue;
      }

      decorations.push({ range });
    }

    return decorations;
  }

  private recreateGutterDecorationType(): void {
    this.gutterDecorationType.dispose();
    this.markerStyle = getConfiguredMarkerStyle();
    this.gutterDecorationType = createMarkerDecorationType(this.extensionPath, this.markerStyle);
  }
}

function buildBlockHoverMessage(line: number, sourceFile: string): vscode.MarkdownString {
  const commandArgs = encodeURIComponent(JSON.stringify([line, sourceFile]));
  const markdown = new vscode.MarkdownString(
    `[Note Actions](command:frilvault.gutter.showActions?${commandArgs})`,
  );
  markdown.isTrusted = {
    enabledCommands: ['frilvault.gutter.showActions'],
  };
  return markdown;
}

function lineDecorationRange(document: vscode.TextDocument, line: number): vscode.Range {
  const lineText = document.lineAt(line);

  if (lineText.text.length > 0) {
    return new vscode.Range(line, 0, line, 1);
  }

  return lineText.rangeIncludingLineBreak;
}
