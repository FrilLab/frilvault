use std::fs;

use crate::{
    FrilVaultError, FrilVaultResult,
    constants::{CACHE_DIR_NAME, IMAGES_DIR_NAME, INDEX_DIR_NAME, NOTES_DIR_NAME},
    workspace::{PathResolver, VaultMode, WorkspaceMetadata},
};

#[derive(Debug, Clone)]
pub struct WorkspaceRepository {
    path_resolver: PathResolver,
}

impl WorkspaceRepository {
    pub fn new(path_resolver: PathResolver) -> Self {
        Self { path_resolver }
    }

    pub fn load(&self) -> FrilVaultResult<WorkspaceMetadata> {
        let path = self.path_resolver.workspace_metadata_path();
        let content = fs::read_to_string(&path)?;
        let metadata = serde_json::from_str(&content)
            .map_err(|source| FrilVaultError::InvalidWorkspaceMetadata { path, source })?;

        Ok(metadata)
    }

    pub fn exists(&self) -> bool {
        self.path_resolver.workspace_metadata_path().is_file()
    }

    pub(crate) fn require_initialized(&self) -> FrilVaultResult<WorkspaceMetadata> {
        let metadata_path = self.path_resolver.workspace_metadata_path();
        if self.exists() {
            let metadata = self.load()?;
            for directory in [
                NOTES_DIR_NAME,
                CACHE_DIR_NAME,
                INDEX_DIR_NAME,
                IMAGES_DIR_NAME,
            ] {
                let path = self.path_resolver.vault_root().join(directory);
                if !path.is_dir() {
                    return Err(FrilVaultError::IncompleteWorkspace(path));
                }
            }
            return Ok(metadata);
        }

        if self.path_resolver.vault_root_ref().exists() {
            return Err(FrilVaultError::IncompleteWorkspace(metadata_path));
        }

        Err(FrilVaultError::WorkspaceNotFound)
    }

    pub fn save(&self, metadata: &WorkspaceMetadata) -> FrilVaultResult<()> {
        let path = self.path_resolver.workspace_metadata_path();

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let json = serde_json::to_string(metadata)?;

        fs::write(path, json)?;

        Ok(())
    }

    pub(crate) fn initialize(&self, mode: VaultMode) -> FrilVaultResult<WorkspaceMetadata> {
        let vault_root = self.path_resolver.vault_root();
        let path = self.path_resolver.workspace_metadata_path();
        let existing_metadata = if path.exists() {
            Some(self.load()?)
        } else {
            None
        };

        if existing_metadata.is_none()
            && self.path_resolver.vault_is_in_git_metadata()
            && vault_root.is_dir()
        {
            let mut entries = fs::read_dir(&vault_root)?;
            if entries.next().transpose()?.is_some() {
                return Err(FrilVaultError::IncompleteWorkspace(path));
            }
        }

        for directory in [
            NOTES_DIR_NAME,
            CACHE_DIR_NAME,
            INDEX_DIR_NAME,
            IMAGES_DIR_NAME,
        ] {
            fs::create_dir_all(vault_root.join(directory))?;
        }

        if let Some(metadata) = existing_metadata {
            return Ok(metadata);
        }

        let metadata = WorkspaceMetadata {
            mode,
            ..WorkspaceMetadata::default()
        };

        self.save(&metadata)?;

        Ok(metadata)
    }
}
