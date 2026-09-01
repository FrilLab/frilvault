//! Workspace-level application services.
//!
//! Provides statistics, health checks, sync, and repair workflows that operate
//! across the whole workspace rather than a single note file.
//!
//! 워크스페이스 전체를 대상으로 하는 통계, 상태 점검, 동기화, 복구
//! 워크플로를 제공합니다.

use crate::{
    FrilVaultResult, NoteAnchor, RepairSuggestion, SyncResult, WorkspaceExplorer, WorkspaceHealth,
    WorkspaceStats,
    runtime::VaultContext,
    workspace::{
        ContentMatcher, FileMove, IndexDiff, RepairEngine, WorkspaceIndex,
        WorkspaceIndexRepository, WorkspaceWatcher, build_workspace_explorer,
        content_match::read_source_file_content,
    },
};

const REPAIR_MIN_CONFIDENCE: f32 = 0.7;

/// Application service responsible for workspace-level operations.
///
/// Examples include stats, health checks, and repair suggestions.
///
/// 통계, 상태 점검, 복구 제안 같은 workspace 수준 연산을 담당합니다.
pub struct WorkspaceService {
    pub vault_context: VaultContext,
    pub index_repository: WorkspaceIndexRepository,
    notes_watcher: WorkspaceWatcher,
}

impl WorkspaceService {
    pub fn new(vault_context: VaultContext, index_repository: WorkspaceIndexRepository) -> Self {
        let notes_watcher = WorkspaceWatcher::new(index_repository.clone());

        Self {
            vault_context,
            index_repository,
            notes_watcher,
        }
    }

    pub fn warm_up(&mut self) -> FrilVaultResult<WorkspaceIndex> {
        let index = self.index_repository.load_or_rebuild()?;
        self.notes_watcher.seed_snapshot(index.clone());

        Ok(index)
    }

    /// Synchronize index and cache state after external note directory changes.
    ///
    /// Editor integrations should invoke this from a file watcher callback when
    /// `.vault/notes` is created, modified, moved, or deleted outside FrilVault.
    pub fn sync_notes_directory_changes(&mut self) -> FrilVaultResult<()> {
        self.notes_watcher.sync(&mut self.vault_context)
    }

    /// Synchronize note files after source files are renamed or moved in the workspace.
    ///
    /// Editor integrations should invoke this from a file rename/move callback when
    /// a tracked source file changes path outside FrilVault.
    pub fn sync_source_file_changes(&mut self) -> FrilVaultResult<usize> {
        let _ = self.index_repository.load_and_refresh_exists()?;
        let repaired = self.apply_repairs()?;

        if repaired > 0 {
            let index = self.index_repository.load()?;
            self.notes_watcher.seed_snapshot(index);
        }

        Ok(repaired)
    }

    pub fn sync_external_changes(
        &mut self,
        sync_notes: bool,
        sync_sources: bool,
    ) -> FrilVaultResult<SyncResult> {
        let mut notes_synced = false;

        if sync_notes {
            self.sync_notes_directory_changes()?;
            notes_synced = true;
        }

        let repairs_applied = if sync_sources {
            self.sync_source_file_changes()?
        } else {
            0
        };

        Ok(SyncResult {
            notes_synced,
            repairs_applied,
        })
    }

    pub fn is_vault_gitignored(&self) -> FrilVaultResult<bool> {
        crate::workspace::gitignore::is_vault_gitignored_at(
            self.index_repository.workspace_root(),
            self.index_repository.vault_root(),
        )
    }

    pub fn append_vault_to_gitignore(&self) -> FrilVaultResult<()> {
        crate::workspace::gitignore::append_vault_to_gitignore_at(
            self.index_repository.workspace_root(),
            self.index_repository.vault_root(),
        )
    }

    pub fn stats(&mut self) -> FrilVaultResult<WorkspaceStats> {
        let index = self.index_repository.load_and_refresh_exists()?;

        let records = self.vault_context.list_all_note_files()?;

        let mut stats = WorkspaceStats {
            file_count: index.files.len(),
            ..Default::default()
        };

        for file in index.files {
            stats.total_notes += file.note_count;

            if file.exists {
                stats.existing_files += 1;
            } else {
                stats.missing_files += 1;
            }
        }

        for record in records {
            for note in record.note_file.notes {
                match note.anchor {
                    NoteAnchor::Line(_) => stats.line_notes += 1,
                    NoteAnchor::Symbol(_) => stats.symbol_notes += 1,
                }
            }
        }

        Ok(stats)
    }

    pub fn index(&mut self) -> FrilVaultResult<WorkspaceIndex> {
        self.index_repository.load_and_refresh_exists()
    }

    pub fn explorer(&mut self) -> FrilVaultResult<WorkspaceExplorer> {
        let index = self.index_repository.load_and_refresh_exists()?;
        let exists_by_file = index
            .files
            .iter()
            .map(|file| (file.source_file.clone(), file.exists))
            .collect::<std::collections::HashMap<_, _>>();

        let records = self.vault_context.list_all_note_files()?;

        let entries = records.into_iter().map(|record| {
            let source_file = record.source_file.to_string_lossy().into_owned();
            let exists = exists_by_file.get(&source_file).copied().unwrap_or(true);

            (source_file, exists, record.note_file.notes)
        });

        Ok(build_workspace_explorer(entries))
    }

    pub fn health_check(&mut self) -> FrilVaultResult<WorkspaceHealth> {
        let index = self.index_repository.load_and_refresh_exists()?;

        let mut health = WorkspaceHealth::default();

        for file in index.files {
            if !file.exists {
                health.missing_source_files.push(file.source_file);
            }
        }

        Ok(health)
    }

    pub fn repair_suggestions(&mut self) -> FrilVaultResult<Vec<RepairSuggestion>> {
        let health = self.health_check()?;
        let workspace_files = self.vault_context.scan_workspace_files()?;
        let workspace_root = self.index_repository.workspace_root();

        let mut suggestions = Vec::new();

        for missing_file in health.missing_source_files {
            let markers = self
                .vault_context
                .load_notes(std::path::Path::new(&missing_file))
                .ok()
                .map(|note_file| ContentMatcher::extract_markers(&note_file))
                .unwrap_or_default();

            let mut candidates: Vec<(String, f32)> = workspace_files
                .iter()
                .filter(|candidate| *candidate != &missing_file)
                .filter_map(|candidate| {
                    let path_score = IndexDiff::similarity_score(&missing_file, candidate);
                    let content_score = if markers.is_empty() {
                        0.0
                    } else if let Some(content) =
                        read_source_file_content(workspace_root, candidate)
                    {
                        ContentMatcher::match_score(&markers, &content)
                    } else {
                        0.0
                    };
                    let score = IndexDiff::combined_repair_score(path_score, content_score);

                    if score >= REPAIR_MIN_CONFIDENCE {
                        Some((candidate.clone(), score))
                    } else {
                        None
                    }
                })
                .collect();

            candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

            suggestions.push(RepairSuggestion {
                missing_file,
                candidates: candidates.into_iter().map(|(path, _)| path).collect(),
            });
        }

        Ok(suggestions)
    }

    pub fn repair_confidence(
        &mut self,
        missing_file: &str,
        candidate: &str,
    ) -> FrilVaultResult<f32> {
        let markers = self
            .vault_context
            .load_notes(std::path::Path::new(missing_file))
            .ok()
            .map(|note_file| ContentMatcher::extract_markers(&note_file))
            .unwrap_or_default();
        let path_score = IndexDiff::similarity_score(missing_file, candidate);
        let content_score = if markers.is_empty() {
            0.0
        } else if let Some(content) =
            read_source_file_content(self.index_repository.workspace_root(), candidate)
        {
            ContentMatcher::match_score(&markers, &content)
        } else {
            0.0
        };

        Ok(IndexDiff::combined_repair_score(path_score, content_score))
    }

    pub fn apply_repair_moves(&mut self, moves: Vec<FileMove>) -> FrilVaultResult<usize> {
        let applied = RepairEngine::apply_moves_with_min_confidence(
            &mut self.vault_context,
            moves,
            REPAIR_MIN_CONFIDENCE,
        )?;

        for mv in &applied {
            self.index_repository.move_source_file(&mv.from, &mv.to)?;
        }

        Ok(applied.len())
    }

    pub fn apply_repairs(&mut self) -> FrilVaultResult<usize> {
        let suggestions = self.repair_suggestions()?;

        let moves = suggestions
            .into_iter()
            .filter_map(|suggestion| {
                let from = suggestion.missing_file.clone();
                let to = suggestion.best_candidate()?.clone();
                let confidence = self.repair_confidence(&from, &to).ok()?;

                Some(FileMove {
                    from,
                    to,
                    confidence,
                })
            })
            .collect();

        self.apply_repair_moves(moves)
    }
}
