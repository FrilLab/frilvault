use std::fs;

use crate::{
    FrilVaultResult,
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
        let content = fs::read_to_string(path)?;
        let metadata = serde_json::from_str(&content)?;

        Ok(metadata)
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

    pub fn create_if_missing(&self) -> FrilVaultResult<()> {
        self.initialize(VaultMode::Local).map(|_| ())
    }

    pub fn initialize(&self, mode: VaultMode) -> FrilVaultResult<WorkspaceMetadata> {
        let vault_root = self.path_resolver.vault_root();

        for directory in [
            NOTES_DIR_NAME,
            CACHE_DIR_NAME,
            INDEX_DIR_NAME,
            IMAGES_DIR_NAME,
        ] {
            fs::create_dir_all(vault_root.join(directory))?;
        }

        let path = self.path_resolver.workspace_metadata_path();

        if path.exists() {
            return self.load();
        }

        let metadata = WorkspaceMetadata {
            mode,
            ..WorkspaceMetadata::default()
        };

        self.save(&metadata)?;

        Ok(metadata)
    }
}
