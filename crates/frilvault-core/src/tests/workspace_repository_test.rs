use std::fs;

use super::helper::create_test_workspace;
use crate::{
    FrilVault, VaultMode,
    workspace::{PathResolver, WorkspaceRepository},
};

#[test]
fn create_if_missing_creates_workspace_metadata() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);

    let repository = WorkspaceRepository::new(resolver.clone());

    repository.create_if_missing().unwrap();

    assert!(resolver.workspace_metadata_path().exists());
}

#[test]
fn create_if_missing_creates_default_directories() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let resolver = PathResolver::new(workspace_root);

    let repository = WorkspaceRepository::new(resolver.clone());

    repository.create_if_missing().unwrap();

    assert!(resolver.vault_root().join("notes").exists());

    assert!(resolver.vault_root().join("cache").exists());

    assert!(resolver.vault_root().join("index").exists());
}

#[test]
fn initialize_defaults_to_local_mode_and_persists_it() {
    let workspace = create_test_workspace();
    let resolver = PathResolver::new(workspace.root());
    let vault = FrilVault::open(workspace.root()).unwrap();

    let mode = vault.initialize(VaultMode::Local).unwrap();
    let metadata = WorkspaceRepository::new(resolver.clone()).load().unwrap();
    let persisted: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(resolver.workspace_metadata_path()).unwrap())
            .unwrap();

    assert_eq!(mode, VaultMode::Local);
    assert_eq!(metadata.mode, VaultMode::Local);
    assert_eq!(persisted["mode"], "local");
}

#[test]
fn initialize_can_create_shared_vault() {
    let workspace = create_test_workspace();
    let resolver = PathResolver::new(workspace.root());
    let vault = FrilVault::open(workspace.root()).unwrap();

    let mode = vault.initialize(VaultMode::Shared).unwrap();
    let metadata = WorkspaceRepository::new(resolver.clone()).load().unwrap();
    let persisted: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(resolver.workspace_metadata_path()).unwrap())
            .unwrap();

    assert_eq!(mode, VaultMode::Shared);
    assert_eq!(metadata.mode, VaultMode::Shared);
    assert_eq!(persisted["mode"], "shared");
}

#[test]
fn legacy_workspace_without_mode_loads_as_local() {
    let workspace = create_test_workspace();
    let resolver = PathResolver::new(workspace.root());
    let repository = WorkspaceRepository::new(resolver.clone());
    repository.create_if_missing().unwrap();

    let metadata_path = resolver.workspace_metadata_path();
    let mut metadata: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    metadata.as_object_mut().unwrap().remove("mode");
    fs::write(&metadata_path, serde_json::to_string(&metadata).unwrap()).unwrap();

    let loaded = repository.load().unwrap();

    assert_eq!(loaded.mode, VaultMode::Local);
}

#[test]
fn initializing_legacy_workspace_preserves_notes_and_metadata() {
    let workspace = create_test_workspace();
    let resolver = PathResolver::new(workspace.root());
    let repository = WorkspaceRepository::new(resolver.clone());
    repository.create_if_missing().unwrap();

    let metadata_path = resolver.workspace_metadata_path();
    let mut metadata: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    metadata.as_object_mut().unwrap().remove("mode");
    let legacy_metadata = serde_json::to_string(&metadata).unwrap();
    fs::write(&metadata_path, &legacy_metadata).unwrap();

    let note_path = resolver.vault_root().join("notes/src/main.rs.json");
    fs::create_dir_all(note_path.parent().unwrap()).unwrap();
    fs::write(&note_path, "legacy note data").unwrap();

    let vault = FrilVault::open(workspace.root()).unwrap();
    let mode = vault.initialize(VaultMode::Shared).unwrap();

    assert_eq!(mode, VaultMode::Local);
    assert_eq!(fs::read_to_string(note_path).unwrap(), "legacy note data");
    assert_eq!(fs::read_to_string(metadata_path).unwrap(), legacy_metadata);
}

#[test]
fn repeated_initialization_preserves_existing_mode_and_configuration() {
    let workspace = create_test_workspace();
    let resolver = PathResolver::new(workspace.root());
    let vault = FrilVault::open(workspace.root()).unwrap();

    vault.initialize(VaultMode::Shared).unwrap();
    let metadata_path = resolver.workspace_metadata_path();
    let original_metadata = fs::read_to_string(&metadata_path).unwrap();

    let mode = vault.initialize(VaultMode::Local).unwrap();

    assert_eq!(mode, VaultMode::Shared);
    assert_eq!(
        fs::read_to_string(metadata_path).unwrap(),
        original_metadata
    );
}
