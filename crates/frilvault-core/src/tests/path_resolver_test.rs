use std::fs;
use std::path::Path;
use std::process::Command;

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
    fs::write(nested.join(".vault/workspace.json"), "{}").unwrap();
    fs::write(workspace.root().join(".vault/workspace.json"), "{}").unwrap();

    let resolver = PathResolver::discover_from(workspace.root(), &nested).unwrap();

    assert_eq!(resolver.workspace_root(), workspace.root());
    assert_eq!(resolver.vault_root(), nested.join(".vault"));
}

#[test]
fn discovery_keeps_legacy_project_root_vault_when_no_nested_vault_exists() {
    let workspace = create_test_workspace();
    fs::create_dir_all(workspace.root().join(".vault")).unwrap();
    fs::write(workspace.root().join(".vault/workspace.json"), "{}").unwrap();
    let nested = workspace.root().join("packages/app");
    fs::create_dir_all(&nested).unwrap();

    let resolver = PathResolver::discover_from(workspace.root(), &nested).unwrap();

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
fn fresh_git_local_vault_uses_checkout_git_directory_and_is_rediscovered() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let git_dir = git_output(workspace.root(), &["rev-parse", "--absolute-git-dir"]);
    let expected = Path::new(&git_dir).join("frilvault/vaults/root");

    assert!(matches!(
        FrilVault::open(workspace.root()).unwrap().status(),
        Err(FrilVaultError::WorkspaceNotFound)
    ));
    assert!(!expected.exists());
    assert!(!workspace.root().join(".vault").exists());

    let vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
    vault.initialize(VaultMode::Local).unwrap();

    assert_eq!(vault.vault_root(), expected);
    assert!(expected.join("workspace.json").is_file());
    assert!(!workspace.root().join(".vault").exists());
    assert_eq!(
        FrilVault::open(workspace.root()).unwrap().vault_root(),
        expected
    );
    assert_eq!(
        vault.status().unwrap().git_tracking,
        crate::GitTrackingStatus::OutsideWorkTree
    );
}

#[test]
fn empty_project_dot_vault_does_not_redirect_new_git_local_storage() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    fs::create_dir(workspace.root().join(".vault")).unwrap();

    let vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
    vault.initialize(VaultMode::Local).unwrap();

    assert!(vault.vault_is_in_git_metadata());
    assert!(!workspace.root().join(".vault/workspace.json").exists());
    assert!(vault.vault_root().join("workspace.json").exists());
}

#[test]
fn fresh_git_shared_vault_uses_project_root_dot_vault() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);

    let vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Shared).unwrap();
    vault.initialize(VaultMode::Shared).unwrap();

    assert_eq!(vault.vault_root(), workspace.root().join(".vault"));
    assert!(workspace.root().join(".vault/workspace.json").is_file());
}

#[test]
fn existing_project_root_vault_is_preserved_and_takes_precedence() {
    for mode in [VaultMode::Local, VaultMode::Shared] {
        let workspace = create_test_workspace();
        git(workspace.root(), &["init"]);
        let old_vault =
            FrilVault::open_with_vault_path(workspace.root(), workspace.root().join(".vault"))
                .unwrap();
        old_vault.initialize(mode).unwrap();
        let note = workspace.root().join(".vault/notes/keep.txt");
        fs::write(&note, "existing note data").unwrap();

        let resolved =
            FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
        assert_eq!(resolved.vault_root(), workspace.root().join(".vault"));
        assert_eq!(resolved.status().unwrap().mode, mode);
        resolved.initialize(VaultMode::Local).unwrap();
        assert_eq!(resolved.status().unwrap().mode, mode);
        assert_eq!(fs::read_to_string(note).unwrap(), "existing note data");
        assert!(
            !git_dir_for(workspace.root())
                .join("frilvault/vaults/root")
                .exists()
        );
    }
}

#[test]
fn legacy_metadata_stays_in_place_without_mode_rewrite() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let vault_path = workspace.root().join(".vault");
    let vault = FrilVault::open_with_vault_path(workspace.root(), &vault_path).unwrap();
    vault.initialize(VaultMode::Local).unwrap();
    let metadata = vault_path.join("workspace.json");
    let mut json: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&metadata).unwrap()).unwrap();
    json.as_object_mut().unwrap().remove("mode");
    let original = serde_json::to_string(&json).unwrap();
    fs::write(&metadata, &original).unwrap();

    let reopened =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Shared).unwrap();
    reopened.initialize(VaultMode::Shared).unwrap();

    assert_eq!(reopened.vault_root(), vault_path);
    assert_eq!(fs::read_to_string(metadata).unwrap(), original);
    assert!(
        !git_dir_for(workspace.root())
            .join("frilvault/vaults/root")
            .exists()
    );
}

#[test]
fn explicit_external_vault_location_and_mode_are_independent() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let external = create_test_workspace();
    let vault = FrilVault::open_for_initialization(
        workspace.root(),
        Some(external.root()),
        VaultMode::Shared,
    )
    .unwrap();
    vault.initialize(VaultMode::Shared).unwrap();

    assert_eq!(vault.vault_root(), external.root());
    assert_eq!(vault.status().unwrap().mode, VaultMode::Shared);
    assert!(!workspace.root().join(".vault").exists());
    assert!(
        !git_dir_for(workspace.root())
            .join("frilvault/vaults/root")
            .exists()
    );
}

#[test]
fn explicit_invalid_vault_does_not_fall_back_to_existing_vault() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let original =
        FrilVault::open_with_vault_path(workspace.root(), workspace.root().join(".vault")).unwrap();
    original.initialize(VaultMode::Shared).unwrap();
    let missing = workspace.root().join("external-vault");

    let explicit =
        FrilVault::open_for_initialization(workspace.root(), Some(&missing), VaultMode::Local)
            .unwrap();
    assert!(matches!(
        explicit.status(),
        Err(FrilVaultError::WorkspaceNotFound)
    ));
    assert_eq!(explicit.vault_root(), missing);
    assert!(!missing.exists());
}

#[test]
fn linked_worktree_local_vaults_use_distinct_per_checkout_git_directories() {
    let workspace = create_test_workspace();
    let worktree_parent = create_test_workspace();
    git(workspace.root(), &["init"]);
    git(
        workspace.root(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "init",
        ],
    );
    let linked = worktree_parent.root().join("linked");
    git(
        workspace.root(),
        &[
            "worktree",
            "add",
            "-b",
            "linked-vault-test",
            linked.to_str().unwrap(),
        ],
    );
    let main_git_dir = git_dir_for(workspace.root());
    let linked_git_dir = git_dir_for(&linked);
    assert_ne!(main_git_dir, linked_git_dir);

    let main_vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
    main_vault.initialize(VaultMode::Local).unwrap();
    let linked_vault = FrilVault::open_for_initialization(&linked, None, VaultMode::Local).unwrap();
    linked_vault.initialize(VaultMode::Local).unwrap();

    assert_eq!(
        main_vault.vault_root(),
        main_git_dir.join("frilvault/vaults/root")
    );
    assert_eq!(
        linked_vault.vault_root(),
        linked_git_dir.join("frilvault/vaults/root")
    );
    assert_ne!(main_vault.vault_root(), linked_vault.vault_root());
    assert!(!workspace.root().join(".vault").exists());
    assert!(!linked.join(".vault").exists());
}

#[test]
fn distinct_workspaces_in_one_checkout_have_distinct_local_vaults() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let nested = workspace.root().join("packages/app");
    fs::create_dir_all(&nested).unwrap();

    let root_vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
    root_vault.initialize(VaultMode::Local).unwrap();
    let nested_vault = FrilVault::open_for_initialization(&nested, None, VaultMode::Local).unwrap();
    nested_vault.initialize(VaultMode::Local).unwrap();

    assert_ne!(root_vault.vault_root(), nested_vault.vault_root());
    assert!(root_vault.vault_root().join("workspace.json").is_file());
    assert!(nested_vault.vault_root().join("workspace.json").is_file());
    assert_eq!(
        FrilVault::open(&nested).unwrap().vault_root(),
        nested_vault.vault_root()
    );
    assert!(!workspace.root().join(".vault").exists());
}

#[test]
fn non_git_initialization_keeps_project_root_vault_and_reads_create_nothing() {
    let workspace = create_test_workspace();
    let before = FrilVault::open(workspace.root()).unwrap();
    assert!(matches!(
        before.status(),
        Err(FrilVaultError::WorkspaceNotFound)
    ));
    assert!(!workspace.root().join(".vault").exists());

    let vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
    vault.initialize(VaultMode::Local).unwrap();

    assert_eq!(vault.vault_root(), workspace.root().join(".vault"));
    assert!(vault.vault_root().join("workspace.json").is_file());
}

#[test]
fn multiple_existing_vaults_require_an_explicit_path() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let local_path = Path::new(&git_output(
        workspace.root(),
        &["rev-parse", "--absolute-git-dir"],
    ))
    .join("frilvault/vaults/root");
    FrilVault::open_with_vault_path(workspace.root(), &local_path)
        .unwrap()
        .initialize(VaultMode::Local)
        .unwrap();
    FrilVault::open_with_vault_path(workspace.root(), workspace.root().join(".vault"))
        .unwrap()
        .initialize(VaultMode::Shared)
        .unwrap();

    assert!(matches!(
        FrilVault::open(workspace.root()),
        Err(FrilVaultError::AmbiguousVaultPaths { .. })
    ));
}

#[test]
fn nonempty_unrecognized_git_vault_directory_is_never_initialized_over() {
    let workspace = create_test_workspace();
    git(workspace.root(), &["init"]);
    let collision = git_dir_for(workspace.root()).join("frilvault/vaults/root");
    fs::create_dir_all(&collision).unwrap();
    let other_tool_data = collision.join("other-tool-data");
    fs::write(&other_tool_data, "preserve me").unwrap();

    let vault =
        FrilVault::open_for_initialization(workspace.root(), None, VaultMode::Local).unwrap();
    assert!(matches!(
        vault.initialize(VaultMode::Local),
        Err(FrilVaultError::IncompleteWorkspace(_))
    ));

    assert_eq!(fs::read_to_string(other_tool_data).unwrap(), "preserve me");
    assert!(!collision.join("workspace.json").exists());
    assert!(!workspace.root().join(".vault").exists());
}

fn git(directory: &Path, arguments: &[&str]) {
    let output = Command::new("git")
        .args(["-C"])
        .arg(directory)
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        arguments,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_output(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .args(["-C"])
        .arg(directory)
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn git_dir_for(directory: &Path) -> std::path::PathBuf {
    Path::new(&git_output(directory, &["rev-parse", "--absolute-git-dir"])).to_path_buf()
}

#[test]
fn nested_vault_initialization_does_not_generate_agents_file() {
    let workspace = create_test_workspace();
    let nested = workspace.root().join("packages/app");
    fs::create_dir_all(&nested).unwrap();

    FrilVault::open(&nested)
        .unwrap()
        .initialize(VaultMode::Local)
        .unwrap();

    assert!(!nested.join(".vault/AGENTS.md").exists());
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
    assert!(!external.root().join("AGENTS.md").exists());
    assert!(!workspace.root().join(".vault").exists());
    let view = notes.list_notes("src/main.rs").unwrap();
    assert_eq!(view[0].source_file, std::path::Path::new("src/main.rs"));
    assert_eq!(vault.status().unwrap().mode, VaultMode::Shared);
}
