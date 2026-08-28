/**
 * VS Code commands for the note viewer feature.
 *
 * note viewer feature의 VS Code command입니다.
 */
import type { NoteViewerController } from './noteViewerController';
import type { GutterNoteActions } from '../decorations/gutterActions';

export function createToggleNoteViewerCommand(
  controller: NoteViewerController,
): (noteIds: string | string[], documentUri?: string) => void {
  return (noteIds: string | string[], documentUri?: string) => {
    controller.toggleNotes(
      Array.isArray(noteIds) ? noteIds : [noteIds],
      documentUri,
    );
  };
}

export function createNoteViewerActionsCommand(
  actions: GutterNoteActions,
): (noteIds: string | string[], sourceFile: string) => Promise<void> {
  return async (noteIds: string | string[], sourceFile: string) => {
    await actions.showActionsForNotes(
      Array.isArray(noteIds) ? noteIds : [noteIds],
      sourceFile,
    );
  };
}
