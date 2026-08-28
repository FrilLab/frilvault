use std::{fs, process::Command};

use super::helper::create_test_workspace;
use crate::{
    AddNoteRequest, FrilVault, FrilVaultError, GitTrackingStatus, LineAnchor, NoteAnchor,
    VaultMode, workspace::PathResolver,
};

#[test]
fn frilvault_open_creates_note_service() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let vault = FrilVault::open(workspace_root).unwrap();

    let mut notes = vault.notes().unwrap();

    notes
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "facade note".to_string(),
            tags: None,
        })
        .unwrap();

    let result = notes.list_notes("src/main.rs").unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].note.content, "facade note");
}

#[test]
fn frilvault_open_creates_workspace_service() {
    let workspace = create_test_workspace();
    let workspace_root = workspace.root();
    let vault = FrilVault::open(workspace_root).unwrap();

    let mut workspace = vault.workspace().unwrap();

    let stats = workspace.stats().unwrap();

    assert_eq!(stats.file_count, 0);
}

#[test]
fn status_reports_local_vault_outside_git_repository_without_writing() {
    let workspace = create_test_workspace();
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Local).unwrap();
    let resolver = PathResolver::new(workspace.root());
    let index_path = resolver.workspace_index_path();

    let status = vault.status().unwrap();

    assert_eq!(status.vault_path.to_string_lossy(), ".vault");
    assert_eq!(status.mode, VaultMode::Local);
    assert_eq!(status.git_tracking, GitTrackingStatus::NotGitRepository);
    assert_eq!(status.note_count, 0);
    assert!(!index_path.exists());
}

#[test]
fn status_reports_shared_vault() {
    let workspace = create_test_workspace();
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Shared).unwrap();

    let status = vault.status().unwrap();

    assert_eq!(status.mode, VaultMode::Shared);
}

#[test]
fn status_reports_trackable_vault_in_git_repository() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Shared).unwrap();

    let status = vault.status().unwrap();

    assert_eq!(status.git_tracking, GitTrackingStatus::Trackable);
}

#[test]
fn status_reports_excluded_vault() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    fs::write(workspace.root().join(".gitignore"), ".vault/\n").unwrap();
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Local).unwrap();

    let status = vault.status().unwrap();

    assert_eq!(status.git_tracking, GitTrackingStatus::Excluded);
}

#[test]
fn status_reports_tracked_vault() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Local).unwrap();
    run_git(workspace.root(), &["add", "-f", ".vault/workspace.json"]);

    let status = vault.status().unwrap();

    assert_eq!(status.git_tracking, GitTrackingStatus::Tracked);
}

#[test]
fn status_defaults_legacy_workspace_mode_to_local() {
    let workspace = create_test_workspace();
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Local).unwrap();
    let metadata_path = PathResolver::new(workspace.root()).workspace_metadata_path();
    let mut metadata: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&metadata_path).unwrap()).unwrap();
    metadata.as_object_mut().unwrap().remove("mode");
    fs::write(&metadata_path, serde_json::to_string(&metadata).unwrap()).unwrap();

    let status = vault.status().unwrap();

    assert_eq!(status.mode, VaultMode::Local);
}

#[test]
fn status_fails_without_creating_a_missing_workspace() {
    let workspace = create_test_workspace();
    let vault = FrilVault::open(workspace.root()).unwrap();

    let error = vault.status().unwrap_err();

    assert!(matches!(error, FrilVaultError::WorkspaceNotFound));
    assert!(!workspace.root().join(".vault").exists());
}

#[test]
fn status_reports_corrupted_workspace_metadata() {
    let workspace = create_test_workspace();
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Local).unwrap();
    let metadata_path = PathResolver::new(workspace.root()).workspace_metadata_path();
    fs::write(&metadata_path, "not json").unwrap();

    let error = vault.status().unwrap_err();

    assert!(matches!(
        &error,
        FrilVaultError::InvalidWorkspaceMetadata { .. }
    ));
    assert!(error.to_string().contains("workspace.json is invalid"));
}

#[test]
fn status_counts_current_notes_after_external_changes_without_writing() {
    let workspace = create_test_workspace();
    let vault = FrilVault::open(workspace.root()).unwrap();
    vault.initialize(VaultMode::Local).unwrap();
    let mut notes = vault.notes().unwrap();

    notes
        .add_note(AddNoteRequest {
            source_file: "src/main.rs".into(),
            anchor: NoteAnchor::Line(LineAnchor { line: 1, column: 1 }),
            content: "first".to_string(),
            tags: None,
        })
        .unwrap();

    let resolver = PathResolver::new(workspace.root());
    let index_path = resolver.workspace_index_path();
    let index_before = fs::read(&index_path).unwrap();
    let original_note_path = resolver.resolve_note_path("src/main.rs");
    let external_note_path = resolver.resolve_note_path("src/external.rs");

    // Simulate another process adding a note file after the index was written.
    fs::copy(&original_note_path, &external_note_path).unwrap();

    let status = vault.status().unwrap();

    assert_eq!(status.note_count, 2);

    // Simulate an external edit that changes the number of notes in that file.
    let mut edited_note_file: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&external_note_path).unwrap()).unwrap();
    let first_note = edited_note_file["notes"][0].clone();
    edited_note_file["notes"]
        .as_array_mut()
        .unwrap()
        .push(first_note);
    fs::write(
        &external_note_path,
        serde_json::to_string(&edited_note_file).unwrap(),
    )
    .unwrap();

    assert_eq!(vault.status().unwrap().note_count, 3);

    // Deleting the externally-added file must also be reflected immediately.
    fs::remove_file(&external_note_path).unwrap();
    assert_eq!(vault.status().unwrap().note_count, 1);
    assert_eq!(fs::read(index_path).unwrap(), index_before);
}

fn init_git_repository(workspace_root: &std::path::Path) {
    run_git(workspace_root, &["init", "--quiet"]);
}

fn run_git(workspace_root: &std::path::Path, arguments: &[&str]) {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(workspace_root)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "git command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
