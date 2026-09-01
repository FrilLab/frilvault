use std::{fs, path::Path, process::Command};

use crate::workspace::gitignore::{
    append_vault_to_gitignore, append_vault_to_gitignore_at, is_vault_gitignored,
    is_vault_gitignored_at,
};
use crate::{FrilVaultError, tests::helper::create_test_workspace};

#[test]
fn is_vault_gitignored_returns_false_when_gitignore_is_missing() {
    let workspace = create_test_workspace();

    assert!(!is_vault_gitignored(workspace.root()).unwrap());
}

#[test]
fn is_vault_gitignored_detects_vault_entry() {
    let workspace = create_test_workspace();
    fs::write(workspace.root().join(".gitignore"), ".vault/\n").unwrap();

    assert!(is_vault_gitignored(workspace.root()).unwrap());
}

#[test]
fn is_vault_gitignored_ignores_comments_and_blank_lines() {
    let workspace = create_test_workspace();
    fs::write(
        workspace.root().join(".gitignore"),
        "# local notes\n\nnode_modules/\n",
    )
    .unwrap();

    assert!(!is_vault_gitignored(workspace.root()).unwrap());
}

#[test]
fn append_vault_to_gitignore_creates_gitignore_file() {
    let workspace = create_test_workspace();

    append_vault_to_gitignore(workspace.root()).unwrap();

    let content = fs::read_to_string(workspace.root().join(".gitignore")).unwrap();
    assert!(content.contains(".vault/"));
    assert!(is_vault_gitignored(workspace.root()).unwrap());
}

#[test]
fn append_vault_to_gitignore_appends_to_existing_gitignore() {
    let workspace = create_test_workspace();
    fs::write(workspace.root().join(".gitignore"), "target/\n").unwrap();

    append_vault_to_gitignore(workspace.root()).unwrap();

    let content = fs::read_to_string(workspace.root().join(".gitignore")).unwrap();
    assert!(content.contains("target/"));
    assert!(content.contains(".vault/"));
}

#[test]
fn append_vault_to_gitignore_is_idempotent() {
    let workspace = create_test_workspace();
    fs::write(workspace.root().join(".gitignore"), ".vault/\n").unwrap();

    append_vault_to_gitignore(workspace.root()).unwrap();

    let content = fs::read_to_string(workspace.root().join(".gitignore")).unwrap();
    assert_eq!(content.matches(".vault/").count(), 1);
}

#[test]
fn external_vault_uses_the_selected_repository_gitignore() {
    let workspace = create_test_workspace();
    let vault_repository = create_test_workspace();
    let vault_root = vault_repository.root().join("vault");
    init_git_repository(vault_repository.root());
    fs::create_dir_all(&vault_root).unwrap();

    append_vault_to_gitignore_at(workspace.root(), &vault_root).unwrap();

    assert_eq!(
        fs::read_to_string(vault_repository.root().join(".gitignore")).unwrap(),
        "vault/\n"
    );
    assert!(!workspace.root().join(".gitignore").exists());
    assert!(is_vault_gitignored_at(workspace.root(), &vault_root).unwrap());
}

#[test]
fn external_vault_without_git_repository_reports_unavailable_gitignore() {
    let workspace = create_test_workspace();
    let external_vault = create_test_workspace();

    let result = append_vault_to_gitignore_at(workspace.root(), external_vault.root());

    assert!(matches!(
        result,
        Err(FrilVaultError::VaultGitignoreUnavailable(path)) if path == external_vault.root()
    ));
    assert!(!workspace.root().join(".gitignore").exists());
}

#[test]
fn gitignore_paths_are_written_with_forward_slashes() {
    let workspace = create_test_workspace();
    let vault_root = workspace.root().join("data").join("vault");
    fs::create_dir_all(&vault_root).unwrap();

    append_vault_to_gitignore_at(workspace.root(), &vault_root).unwrap();

    assert_eq!(
        fs::read_to_string(workspace.root().join(".gitignore")).unwrap(),
        "data/vault/\n"
    );
}

fn init_git_repository(root: &Path) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["init", "--quiet"])
        .status()
        .unwrap();
    assert!(status.success());
}
