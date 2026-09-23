use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::{
    note::{NoteRepository, NoteService},
    runtime::VaultContext,
    workspace::{PathResolver, WorkspaceIndexRepository, WorkspaceRepository, WorkspaceService},
};

pub struct TestWorkspace {
    root: PathBuf,
}

impl TestWorkspace {
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn create_test_workspace() -> TestWorkspace {
    let root = std::env::temp_dir().join(format!("frilvault-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();

    TestWorkspace { root }
}

pub fn create_test_note_service(workspace_root: &Path) -> NoteService {
    let vault_context = create_test_vault_context(workspace_root);
    NoteService::new(vault_context)
}

pub fn create_test_vault_context(workspace_root: &Path) -> VaultContext {
    let resolver = PathResolver::new(workspace_root);
    let workspace_repository = WorkspaceRepository::new(resolver.clone());
    workspace_repository
        .initialize(crate::workspace::VaultMode::Local)
        .unwrap();

    let note_repository = NoteRepository::new(resolver.clone());
    let index_repository = WorkspaceIndexRepository::new(resolver);
    index_repository.create_if_missing().unwrap();

    VaultContext::new(note_repository, index_repository)
}

pub fn create_test_workspace_service(workspace_root: &Path) -> WorkspaceService {
    let vault_context = create_test_vault_context(workspace_root);
    let resolver = PathResolver::new(workspace_root);
    let repository = WorkspaceIndexRepository::new(resolver);

    WorkspaceService::new(vault_context, repository)
}

pub fn create_test_index_repository(workspace_root: &Path) -> WorkspaceIndexRepository {
    let resolver = PathResolver::new(workspace_root);
    WorkspaceIndexRepository::new(resolver)
}

pub fn create_test_repository(workspace_root: &Path) -> NoteRepository {
    let resolver = PathResolver::new(workspace_root);
    NoteRepository::new(resolver)
}
