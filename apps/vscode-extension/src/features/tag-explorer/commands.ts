import * as vscode from 'vscode';

import type { CliClient } from '../../core/cliClient';
import { TAG_COLOR_OPTIONS, tagColorMarker } from '../presentation/tagColor';
import type { TagExplorerTagItem } from './view';

export interface TagColorCommandDependencies {
  cliClient: CliClient;
  getWorkspaceRoot: () => string;
  refresh: () => Promise<void>;
}

export function createSetTagColorCommand(dependencies: TagColorCommandDependencies) {
  return async (item: TagExplorerTagItem): Promise<void> => {
    if (!item?.summary) {
      return;
    }

    const selection = await vscode.window.showQuickPick(
      TAG_COLOR_OPTIONS.map((option) => ({
        label: `${tagColorMarker(option.color)} ${option.label}`,
        color: option.color,
      })),
      { placeHolder: `Choose a color for #${item.summary.tag}` },
    );
    if (!selection) {
      return;
    }

    await dependencies.cliClient.tagColorSet(
      dependencies.getWorkspaceRoot(),
      item.summary.tag,
      selection.color,
    );
    await dependencies.refresh();
  };
}

export function createRemoveTagColorCommand(dependencies: TagColorCommandDependencies) {
  return async (item: TagExplorerTagItem): Promise<void> => {
    if (!item?.summary) {
      return;
    }

    await dependencies.cliClient.tagColorRemove(
      dependencies.getWorkspaceRoot(),
      item.summary.tag,
    );
    await dependencies.refresh();
  };
}
