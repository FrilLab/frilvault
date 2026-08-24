//! Stable note URI parsing and resolution.
//!
//! URIs identify notes by id and workspace root. They do not encode source paths,
//! so links remain valid across file renames when the note id still exists.
//!
//! stable note URI 파싱과 해석을 제공합니다.
//!
//! URI는 id와 workspace root로 note를 식별하며 source path를 담지 않아,
//! note id가 유효하면 파일 rename 이후에도 링크가 유지됩니다.
mod note_uri;

pub use note_uri::{NOTE_URI_SCHEME, NOTE_URI_VERSION, ParsedNoteUri};

use std::path::Path;

use uuid::Uuid;

use crate::{
    FrilVaultError, FrilVaultResult, NoteAnchor, NoteView, note::NoteService,
    workspace::WorkspaceIndex,
};

/// Serializes, parses, and resolves stable FrilVault note URIs.
///
/// stable FrilVault note URI를 직렬화, 파싱, 해석합니다.
pub struct NoteUriResolver;

impl NoteUriResolver {
    pub fn serialize(note_id: Uuid, workspace_root: &Path) -> FrilVaultResult<String> {
        ParsedNoteUri::serialize(note_id, workspace_root)
    }

    pub fn parse(uri: &str) -> FrilVaultResult<ParsedNoteUri> {
        ParsedNoteUri::parse(uri)
    }

    /// Resolves a URI into a current note view for the open workspace service.
    ///
    /// # Errors
    ///
    /// Returns workspace mismatch, stale-note, or unresolved-anchor errors when the
    /// note cannot be opened safely.
    ///
    /// URI를 열린 workspace service 기준 현재 note view로 해석합니다.
    pub fn resolve(service: &mut NoteService, uri: &str) -> FrilVaultResult<NoteView> {
        let parsed = ParsedNoteUri::parse(uri)?;
        let current_workspace = service.workspace_root();

        if !workspace_paths_match(&parsed.workspace, &current_workspace) {
            return Err(FrilVaultError::UnknownWorkspace(
                parsed.workspace.display().to_string(),
            ));
        }

        let view = service.find_note_by_id(parsed.note_id)?;
        let index = service.load_workspace_index()?;

        ensure_source_file_is_current(&view, &index, parsed.note_id)?;
        ensure_anchor_is_resolvable(&view, parsed.note_id)?;

        Ok(view)
    }
}

fn workspace_paths_match(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }

    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn ensure_source_file_is_current(
    view: &NoteView,
    index: &WorkspaceIndex,
    note_id: Uuid,
) -> FrilVaultResult<()> {
    let source_file = view.source_file.to_string_lossy();
    let indexed = index
        .files
        .iter()
        .find(|file| file.source_file == source_file);

    match indexed {
        Some(file) if file.exists => Ok(()),
        _ => Err(FrilVaultError::StaleNote(note_id)),
    }
}

fn ensure_anchor_is_resolvable(view: &NoteView, note_id: Uuid) -> FrilVaultResult<()> {
    // Symbol notes must resolve in current source text before navigation succeeds.
    // symbol note는 이동 전에 현재 source text에서 해석되어야 합니다.
    if matches!(view.note.anchor, NoteAnchor::Symbol(_)) && view.resolved.is_none() {
        return Err(FrilVaultError::UnresolvedAnchor(note_id));
    }

    Ok(())
}
