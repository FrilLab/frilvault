import * as vscode from 'vscode';

import type { NoteView, TagSummary } from '../../types';
import { prepareTaggedNotes, prepareTagSummaries } from './presentation';
import {
  TagExplorerNoteItem,
  TagExplorerStatusItem,
  TagExplorerTagItem,
  type TagExplorerTreeNode,
} from './view';

export class FrilVaultTagExplorerProvider
implements vscode.TreeDataProvider<TagExplorerTreeNode> {
  private readonly onDidChangeTreeDataEmitter =
    new vscode.EventEmitter<TagExplorerTreeNode | undefined>();
  private tagLoad: Promise<TagSummary[]> | undefined;
  private readonly noteLoads = new Map<string, Promise<NoteView[]>>();

  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly loadTags: () => Promise<TagSummary[]>,
    private readonly loadNotes: (tag: string) => Promise<NoteView[]>,
    private readonly getWorkspaceRoot: () => string,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  public refresh(): void {
    this.tagLoad = undefined;
    this.noteLoads.clear();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: TagExplorerTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: TagExplorerTreeNode): Promise<TagExplorerTreeNode[]> {
    if (!this.isEnabled()) {
      return [new TagExplorerStatusItem('Disabled for this workspace.', 'debug-pause')];
    }

    if (element instanceof TagExplorerTagItem) {
      return this.getNotes(element.summary.tag);
    }

    if (element) {
      return [];
    }

    try {
      this.tagLoad ??= this.loadTags();
      const tags = prepareTagSummaries(await this.tagLoad);

      if (tags.length === 0) {
        return [
          new TagExplorerStatusItem(
            'No tagged notes. Add tags when creating or editing a note.',
            'tag',
          ),
        ];
      }

      return tags.map((summary) => new TagExplorerTagItem(summary));
    } catch (error) {
      this.tagLoad = undefined;
      return [new TagExplorerStatusItem(errorMessage(error, 'Failed to load tags.'), 'error')];
    }
  }

  private async getNotes(tag: string): Promise<TagExplorerTreeNode[]> {
    try {
      let load = this.noteLoads.get(tag);

      if (!load) {
        load = this.loadNotes(tag);
        this.noteLoads.set(tag, load);
      }

      return prepareTaggedNotes(await load).map(
        (note) => new TagExplorerNoteItem(note, this.getWorkspaceRoot()),
      );
    } catch (error) {
      this.noteLoads.delete(tag);
      return [
        new TagExplorerStatusItem(
          errorMessage(error, `Failed to load notes tagged '${tag}'.`),
          'error',
        ),
      ];
    }
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
