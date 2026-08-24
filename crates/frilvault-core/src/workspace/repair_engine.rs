use crate::{FrilVaultResult, runtime::VaultContext, workspace::FileMove};

pub struct RepairEngine;

const DEFAULT_MIN_CONFIDENCE: f32 = 1.0;

impl RepairEngine {
    pub fn apply_moves(
        vault_context: &mut VaultContext,
        moves: Vec<FileMove>,
    ) -> FrilVaultResult<usize> {
        Ok(
            Self::apply_moves_with_min_confidence(vault_context, moves, DEFAULT_MIN_CONFIDENCE)?
                .len(),
        )
    }

    pub fn apply_moves_with_min_confidence(
        vault_context: &mut VaultContext,
        moves: Vec<FileMove>,
        min_confidence: f32,
    ) -> FrilVaultResult<Vec<FileMove>> {
        let moves = moves
            .into_iter()
            .map(|mv| {
                let from = vault_context
                    .normalize_source_file(std::path::Path::new(&mv.from))?
                    .to_string_lossy()
                    .into_owned();
                let to = vault_context
                    .normalize_source_file(std::path::Path::new(&mv.to))?
                    .to_string_lossy()
                    .into_owned();

                Ok(FileMove {
                    from,
                    to,
                    confidence: mv.confidence,
                })
            })
            .collect::<FrilVaultResult<Vec<_>>>()?;
        let mut applied = Vec::new();

        for mv in moves {
            if mv.confidence < min_confidence {
                continue;
            }

            let old_path = vault_context.resolve_note_path(&mv.from);

            let new_path = vault_context.resolve_note_path(&mv.to);

            let to = mv.to.clone();

            vault_context.invalidate_notes(std::path::Path::new(&mv.from));
            vault_context.invalidate_notes(std::path::Path::new(&to));

            if old_path.exists() {
                if let Some(parent) = new_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }

                if new_path.exists() {
                    let old_notes = vault_context
                        .note_repository
                        .load_by_source_file(std::path::Path::new(&mv.from))?;
                    let mut new_notes = vault_context
                        .note_repository
                        .load_by_source_file(std::path::Path::new(&mv.to))?;
                    let mut note_ids = new_notes
                        .notes
                        .iter()
                        .map(|note| note.id)
                        .collect::<std::collections::HashSet<_>>();

                    for note in &old_notes.notes {
                        if !note_ids.insert(note.id) {
                            return Err(crate::FrilVaultError::DuplicateNoteId(note.id));
                        }
                    }

                    new_notes.notes.extend(old_notes.notes);
                    vault_context
                        .note_repository
                        .save_by_source_file(std::path::Path::new(&mv.to), &new_notes)?;
                    std::fs::remove_file(&old_path)?;
                } else {
                    std::fs::rename(&old_path, &new_path)?;
                }
                applied.push(mv);
            }

            let _ = vault_context.load_notes(std::path::Path::new(&to));
        }

        Ok(applied)
    }
}
