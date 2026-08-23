use std::{fs, path::Path};

use crate::{
    FrilVaultResult, RepairSuggestion,
    note::NoteRepository,
    workspace::{FileMove, IndexDiff, IndexedFile, PathResolver, WorkspaceIndex},
};

#[derive(Debug, Clone)]
pub struct WorkspaceIndexRepository {
    path_resolver: PathResolver,
}

impl WorkspaceIndexRepository {
    pub fn new(path_resolver: PathResolver) -> Self {
        Self { path_resolver }
    }

    pub fn workspace_root(&self) -> &Path {
        self.path_resolver.workspace_root()
    }

    pub fn load(&self) -> FrilVaultResult<WorkspaceIndex> {
        let path = self.path_resolver.workspace_index_path();

        if !path.exists() {
            return Ok(WorkspaceIndex::default());
        }

        let content = fs::read_to_string(path)?;

        let index = serde_json::from_str(&content)?;

        Ok(index)
    }

    pub fn exists(&self) -> bool {
        self.path_resolver.workspace_index_path().is_file()
    }

    pub fn save(&self, index: &WorkspaceIndex) -> FrilVaultResult<()> {
        let path = self.path_resolver.workspace_index_path();

        let json = serde_json::to_string(index)?;

        crate::note::atomic_write(&path, &json)?;

        Ok(())
    }

    pub fn create_if_missing(&self) -> FrilVaultResult<()> {
        if let Some(parent) = self.path_resolver.workspace_index_path().parent() {
            fs::create_dir_all(parent)?;
        }

        Ok(())
    }

    pub fn load_or_rebuild(&self) -> FrilVaultResult<WorkspaceIndex> {
        let path = self.path_resolver.workspace_index_path();

        if path.exists() {
            return self.load();
        }

        self.rebuild()
    }

    pub fn rebuild(&self) -> FrilVaultResult<WorkspaceIndex> {
        let note_repository = NoteRepository::new(self.path_resolver.clone());

        let records = note_repository.list_all_note_files()?;

        let files = records
            .into_iter()
            .map(|record| {
                let source_file = record.source_file.to_string_lossy().to_string();

                let exists = self.source_file_exists(&source_file);

                IndexedFile {
                    source_file,
                    note_count: record.note_file.notes.len(),
                    exists,
                }
            })
            .collect();

        let index = WorkspaceIndex { version: 1, files };

        self.save(&index)?;

        Ok(index)
    }

    pub fn load_and_refresh_exists(&self) -> FrilVaultResult<WorkspaceIndex> {
        let mut index = self.load_or_rebuild()?;
        self.refresh_exists_flags(&mut index);

        Ok(index)
    }

    pub fn refresh_exists_flags(&self, index: &mut WorkspaceIndex) {
        for file in &mut index.files {
            file.exists = self.source_file_exists(&file.source_file);
        }
    }

    pub fn sync_source_file(&self, source_file: &str, note_count: usize) -> FrilVaultResult<()> {
        let mut index = self.load_or_rebuild()?;

        index.upsert_file(IndexedFile {
            source_file: source_file.to_string(),
            note_count,
            exists: self.source_file_exists(source_file),
        });

        self.save(&index)
    }

    pub fn remove_source_file(&self, source_file: &str) -> FrilVaultResult<()> {
        let mut index = self.load_or_rebuild()?;
        index.remove_file(source_file);
        self.save(&index)
    }

    pub fn move_source_file(&self, from: &str, to: &str) -> FrilVaultResult<()> {
        let mut index = self.load_or_rebuild()?;

        if !index.move_file(from, to) {
            return Ok(());
        }

        if let Some(file) = index.files.iter_mut().find(|file| file.source_file == to) {
            file.exists = self.source_file_exists(to);
        }

        self.save(&index)
    }

    fn source_file_exists(&self, source_file: &str) -> bool {
        self.path_resolver
            .workspace_root()
            .join(source_file)
            .exists()
    }

    pub fn detect_moves(
        &self,
        old_index: &WorkspaceIndex,
        new_index: &WorkspaceIndex,
    ) -> Vec<FileMove> {
        IndexDiff::diff(old_index, new_index)
    }

    pub fn repair_suggestions(
        &self,
        old_index: &WorkspaceIndex,
        new_index: &WorkspaceIndex,
    ) -> Vec<RepairSuggestion> {
        let moves = self.detect_moves(old_index, new_index);

        RepairSuggestion::from_moves(moves)
    }
}
