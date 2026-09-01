use std::{fs, path::Path, process::Command};

use crate::{FrilVault, GitExcludeStatus, GitTrackingStatus, VaultMode};

use super::helper::create_test_workspace;

#[test]
fn local_init_adds_vault_to_repository_exclude_without_touching_gitignore() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    fs::write(workspace.root().join(".gitignore"), "target/\n").unwrap();
    let original_exclude = read_exclude(workspace.root());

    let result = FrilVault::open(workspace.root())
        .unwrap()
        .initialize_with_status(VaultMode::Local)
        .unwrap();

    assert_eq!(result.git_exclude, Some(GitExcludeStatus::Added));
    assert_eq!(
        read_exclude(workspace.root()),
        format!("{original_exclude}.vault/\n")
    );
    assert_eq!(
        fs::read_to_string(workspace.root().join(".gitignore")).unwrap(),
        "target/\n"
    );
}

#[test]
fn local_init_preserves_existing_exclude_contents_and_is_idempotent() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    let exclude_path = git_path(workspace.root(), "info/exclude");
    fs::write(&exclude_path, "# local excludes\ntarget\n").unwrap();
    let vault = FrilVault::open(workspace.root()).unwrap();

    let first = vault.initialize_with_status(VaultMode::Local).unwrap();
    let second = vault.initialize_with_status(VaultMode::Local).unwrap();

    assert_eq!(first.git_exclude, Some(GitExcludeStatus::Added));
    assert_eq!(second.git_exclude, Some(GitExcludeStatus::AlreadyExcluded));
    assert_eq!(
        fs::read_to_string(exclude_path).unwrap(),
        "# local excludes\ntarget\n.vault/\n"
    );
}

#[test]
fn local_init_recreates_missing_exclude_file() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    let exclude_path = git_path(workspace.root(), "info/exclude");
    fs::remove_file(&exclude_path).unwrap();

    FrilVault::open(workspace.root())
        .unwrap()
        .initialize(VaultMode::Local)
        .unwrap();

    assert_eq!(fs::read_to_string(exclude_path).unwrap(), ".vault/\n");
}

#[test]
fn local_init_outside_git_still_creates_vault() {
    let workspace = create_test_workspace();

    let result = FrilVault::open(workspace.root())
        .unwrap()
        .initialize_with_status(VaultMode::Local)
        .unwrap();

    assert_eq!(result.git_exclude, Some(GitExcludeStatus::NotGitRepository));
    assert!(workspace.root().join(".vault").is_dir());
    assert!(!workspace.root().join(".gitignore").exists());
}

#[test]
fn local_init_detects_tracked_vault_without_changing_index() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    fs::create_dir_all(workspace.root().join(".vault")).unwrap();
    fs::write(workspace.root().join(".vault/tracked.txt"), "tracked").unwrap();
    git(workspace.root(), &["add", ".vault/tracked.txt"]);
    let before = git_stdout(workspace.root(), &["ls-files", "--", ".vault"]);

    let result = FrilVault::open(workspace.root())
        .unwrap()
        .initialize_with_status(VaultMode::Local)
        .unwrap();

    assert_eq!(result.git_exclude, Some(GitExcludeStatus::VaultTracked));
    assert_eq!(
        git_stdout(workspace.root(), &["ls-files", "--", ".vault"]),
        before
    );
    assert!(
        !read_exclude(workspace.root())
            .lines()
            .any(|line| line == ".vault/")
    );
}

#[test]
fn local_init_checks_tracked_vault_from_the_git_root() {
    let workspace = create_test_workspace();
    let nested_workspace = workspace.root().join("packages/app");
    fs::create_dir_all(&nested_workspace).unwrap();
    init_git_repository(workspace.root());
    fs::create_dir_all(workspace.root().join(".vault")).unwrap();
    fs::write(workspace.root().join(".vault/tracked.txt"), "tracked").unwrap();
    git(workspace.root(), &["add", ".vault/tracked.txt"]);

    let result = FrilVault::open(&nested_workspace)
        .unwrap()
        .initialize_with_status(VaultMode::Local)
        .unwrap();

    assert_eq!(result.git_exclude, Some(GitExcludeStatus::VaultTracked));
    assert!(
        !read_exclude(workspace.root())
            .lines()
            .any(|line| line == ".vault/")
    );
}

#[test]
fn local_init_uses_the_selected_external_vault_repository() {
    let workspace = create_test_workspace();
    let vault_repository = create_test_workspace();
    let vault_root = vault_repository.root().join("vault");
    init_git_repository(vault_repository.root());

    let vault = FrilVault::open_with_vault_path(workspace.root(), &vault_root).unwrap();
    let result = vault.initialize_with_status(VaultMode::Local).unwrap();

    assert_eq!(result.git_exclude, Some(GitExcludeStatus::Added));
    assert!(
        read_exclude(vault_repository.root())
            .lines()
            .any(|line| line == "vault/")
    );
    assert_eq!(
        vault.status().unwrap().git_tracking,
        GitTrackingStatus::Excluded
    );
}

#[test]
fn shared_init_does_not_add_local_exclude() {
    let workspace = create_test_workspace();
    init_git_repository(workspace.root());
    let before = read_exclude(workspace.root());

    let result = FrilVault::open(workspace.root())
        .unwrap()
        .initialize_with_status(VaultMode::Shared)
        .unwrap();

    assert_eq!(result.git_exclude, None);
    assert_eq!(read_exclude(workspace.root()), before);
}

#[test]
fn local_init_resolves_exclude_for_git_worktree() {
    let repository = create_test_workspace();
    let worktree_parent = create_test_workspace();
    let worktree_root = worktree_parent.root().join("linked");
    init_git_repository(repository.root());
    fs::write(repository.root().join("README.md"), "fixture\n").unwrap();
    git(repository.root(), &["add", "README.md"]);
    git(
        repository.root(),
        &[
            "-c",
            "user.name=FrilVault Tests",
            "-c",
            "user.email=tests@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
    );
    git(
        repository.root(),
        &[
            "worktree",
            "add",
            "--detach",
            worktree_root.to_str().unwrap(),
        ],
    );

    let result = FrilVault::open(&worktree_root)
        .unwrap()
        .initialize_with_status(VaultMode::Local)
        .unwrap();

    assert_eq!(result.git_exclude, Some(GitExcludeStatus::Added));
    assert!(
        read_exclude(&worktree_root)
            .lines()
            .any(|line| line == ".vault/")
    );
    assert!(worktree_root.join(".git").is_file());
}

fn init_git_repository(root: &Path) {
    git(root, &["init", "--quiet"]);
}

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git command failed: git {args:?}");
}

fn git_stdout(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git command failed: git {args:?}");
    String::from_utf8(output.stdout).unwrap()
}

fn git_path(root: &Path, path: &str) -> std::path::PathBuf {
    let resolved =
        std::path::PathBuf::from(git_stdout(root, &["rev-parse", "--git-path", path]).trim());
    if resolved.is_absolute() {
        resolved
    } else {
        root.join(resolved)
    }
}

fn read_exclude(root: &Path) -> String {
    fs::read_to_string(git_path(root, "info/exclude")).unwrap()
}
