/**
 * VS Code commands for the note viewer feature.
 *
 * note viewer feature의 VS Code command입니다.
 */
import type { NoteViewerController } from './noteViewerController';

export function createToggleNoteViewerCommand(
  controller: NoteViewerController,
): (noteId: string) => void {
  return (noteId: string) => {
    controller.toggleNote(noteId);
  };
}
