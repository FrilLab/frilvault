use std::fs;
use std::path::Path;

use super::helper::create_test_workspace;
use crate::{
    AddNoteRequest, FrilVault, FrilVaultError, LineAnchor, NoteAnchor, PathResolver, VaultMode,
};

#[test]
fn relative_workspace_root_keeps_the_current_directory_anchor() {
    let resolver = PathResolver::new(".");

    assert_eq!(resolver.workspace_root(), Path::new("."));
    assert_eq!(resolver.vault_root(), Path::new(".vault"));
}

#[test]
fn explicit_external_vault_keeps_storage_separate_from_workspace() {
    let workspace = create_test_workspace();
    let external = create_test_workspace();
    fs::create_dir_all(workspace.root().join("src")).unwrap();
    fs::write(workspace.root().join("src/main.rs"), "fn main() {}\n").unwrap();

    let resolver = PathResolver::with_vault_root(workspace.root(), external.root());

    assert_eq!(
        resolver.resolve_note_path("src/main.rs"),
        external.root().join("notes/src/main.rs.json")
    );
    assert_eq!(
        resolver
            .to_workspace_relative(workspace.root().join("src/main.rs"))
            .unwrap(),
        std::path::PathBuf::from("src/main.rs")
    );
    assert_eq!(resolver.display_vault_path(), external.root());
}

#[test]
fn discovery_prefers_nearest_nested_vault_over_project_root_vault() {
    let workspace = create_test_workspace();
    let nested = workspace.root().join("packages/app");
    fs::create_dir_all(nested.join(".vault")).unwrap();
    fs::create_dir_all(workspace.root().join(".vault")).unwrap();

    let resolver = PathResolver::discover_from(workspace.root(), &nested);

    assert_eq!(resolver.workspace_root(), workspace.root());
    assert_eq!(resolver.vault_root(), nested.join(".vault"));
}

#[test]
fn discovery_keeps_legacy_project_root_vault_when_no_nested_vault_exists() {
    let workspace = create_test_workspace();
    fs::create_dir_all(workspace.root().join(".vault")).unwrap();
    let nested = workspace.root().join("packages/app");
    fs::create_dir_all(&nested).unwrap();

    let resolver = PathResolver::discover_from(workspace.root(), &nested);

    assert_eq!(resolver.vault_root(), workspace.root().join(".vault"));
}

#[test]
fn explicit_missing_vault_does_not_fall_back_to_legacy_vault() {
    let workspace = create_test_workspace();
    let external = workspace.root().join("outside-vault");
    let legacy = FrilVault::open(workspace.root()).unwrap();
    legacy.initialize(VaultMode::Local).unwrap();

    let explicit = FrilVault::open_with_vault_path(workspace.root(), &external).unwrap();

    assert!(matches!(
        explicit.status(),
        Err(FrilVaultError::WorkspaceNotFound)
    ));
    assert!(!external.exists());
}

#[test]
fn explicit_file_path_is_rejected_without_falling_back_to_legacy_vault() {
    let workspace = create_test_workspace();
    let legacy = FrilVault::open(workspace.root()).unwrap();
    legacy.initialize(VaultMode::Local).unwrap();
    let explicit_file = workspace.root().join("vault-file");
    fs::write(&explicit_file, "not a directory").unwrap();

    assert!(matches!(
        FrilVault::open_with_vault_path(workspace.root(), &explicit_file),
        Err(FrilVaultError::InvalidVaultPath(path)) if path == explicit_file
    ));
}

#[test]
fn external_vault_preserves_workspace_relative_anchors_and_mode() {
    let workspace = create_test_workspace();
    let external = create_test_workspace();
    fs::create_dir_all(workspace.root().join("src")).unwrap();
    fs::write(workspace.root().join("src/main.rs"), "fn main() {}\n").unwrap();

    let vault = FrilVault::open_with_vault_path(workspace.root(), external.root()).unwrap();
    vault.initialize(VaultMode::Shared).unwrap();
    let mut notes = vault.notes().unwrap();
    notes
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "external vault note".to_string(),
            tags: None,
        })
        .unwrap();

    assert!(external.root().join("notes/src/main.rs.json").exists());
    assert!(!workspace.root().join(".vault").exists());
    let view = notes.list_notes("src/main.rs").unwrap();
    assert_eq!(view[0].source_file, std::path::Path::new("src/main.rs"));
    assert_eq!(vault.status().unwrap().mode, VaultMode::Shared);
}
