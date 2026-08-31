use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;

use crate::{FrilVaultResult, workspace::GitTrackingStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitExcludeStatus {
    Added,
    AlreadyExcluded,
    NotGitRepository,
    VaultTracked,
}

pub fn ensure_local_vault_excluded(workspace_root: &Path) -> FrilVaultResult<GitExcludeStatus> {
    ensure_local_vault_excluded_at(workspace_root, &workspace_root.join(".vault"))
}

pub fn ensure_local_vault_excluded_at(
    _workspace_root: &Path,
    vault_root: &Path,
) -> FrilVaultResult<GitExcludeStatus> {
    let Some((repository_root, relative_vault)) = git_repository_relative_path(vault_root)? else {
        return Ok(GitExcludeStatus::NotGitRepository);
    };

    let Some(exclude_path) = resolve_exclude_path(&repository_root) else {
        return Ok(GitExcludeStatus::NotGitRepository);
    };

    if is_vault_tracked(&repository_root, &relative_vault) {
        return Ok(GitExcludeStatus::VaultTracked);
    }

    let existing = if exclude_path.exists() {
        fs::read_to_string(&exclude_path)?
    } else {
        String::new()
    };

    if existing
        .lines()
        .any(|line| is_vault_exclude_pattern(line, &relative_vault))
    {
        return Ok(GitExcludeStatus::AlreadyExcluded);
    }

    if let Some(parent) = exclude_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(&format!("{}/", git_path_string(&relative_vault)));
    updated.push('\n');
    fs::write(exclude_path, updated)?;

    Ok(GitExcludeStatus::Added)
}

pub fn vault_git_tracking_status(workspace_root: &Path) -> FrilVaultResult<GitTrackingStatus> {
    vault_git_tracking_status_at(workspace_root, &workspace_root.join(".vault"))
}

pub fn vault_git_tracking_status_at(
    _workspace_root: &Path,
    vault_root: &Path,
) -> FrilVaultResult<GitTrackingStatus> {
    let Some((repository_root, relative_vault)) = git_repository_relative_path(vault_root)? else {
        return Ok(GitTrackingStatus::NotGitRepository);
    };

    let inside_work_tree = git_output(&repository_root, &["rev-parse", "--is-inside-work-tree"])?;
    if !inside_work_tree.status.success()
        || String::from_utf8_lossy(&inside_work_tree.stdout).trim() != "true"
    {
        return Ok(GitTrackingStatus::NotGitRepository);
    }

    if is_vault_tracked(&repository_root, &relative_vault) {
        return Ok(GitTrackingStatus::Tracked);
    }

    let relative_vault = git_path_string(&relative_vault);
    let ignored = git_output(
        &repository_root,
        &["check-ignore", "--quiet", "--", &relative_vault],
    )?;
    if ignored.status.success() {
        return Ok(GitTrackingStatus::Excluded);
    }

    Ok(GitTrackingStatus::Trackable)
}

fn git_output(workspace_root: &Path, arguments: &[&str]) -> FrilVaultResult<std::process::Output> {
    Ok(Command::new("git")
        .args(arguments)
        .current_dir(workspace_root)
        .output()?)
}

fn resolve_exclude_path(workspace_root: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["rev-parse", "--git-path", "info/exclude"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let raw_path = String::from_utf8(output.stdout).ok()?;
    let path = PathBuf::from(raw_path.trim());
    if path.as_os_str().is_empty() {
        return None;
    }

    Some(if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    })
}

fn is_vault_tracked(repository_root: &Path, relative_vault: &Path) -> bool {
    let relative_vault = git_path_string(relative_vault);
    Command::new("git")
        .args(["-C"])
        .arg(repository_root)
        .args(["ls-files", "--"])
        .arg(relative_vault)
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

fn is_vault_exclude_pattern(line: &str, relative_vault: &Path) -> bool {
    let pattern = line.split('#').next().unwrap_or("").trim();
    let relative = git_path_string(relative_vault);
    let expected = format!("{relative}/");

    pattern == relative
        || pattern == expected
        || (relative == ".vault"
            && matches!(pattern, ".vault" | ".vault/" | "**/.vault" | "**/.vault/"))
}

pub(crate) fn git_repository_relative_path(
    path: &Path,
) -> FrilVaultResult<Option<(PathBuf, PathBuf)>> {
    let path = canonicalize_with_missing_components(&absolute_path(path)?)?;
    let Some(git_root) = git_worktree_root_for_path(&path)? else {
        return Ok(None);
    };

    let Some(relative_path) = path.strip_prefix(&git_root).ok() else {
        return Ok(None);
    };

    if relative_path.as_os_str().is_empty() {
        return Ok(None);
    }

    Ok(Some((git_root, relative_path.to_path_buf())))
}

fn git_worktree_root_for_path(path: &Path) -> FrilVaultResult<Option<PathBuf>> {
    let existing_ancestor = existing_ancestor(path)?;
    git_worktree_root(&existing_ancestor)
}

fn git_worktree_root(workspace_root: &Path) -> FrilVaultResult<Option<PathBuf>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace_root)
        .args(["rev-parse", "--show-toplevel"])
        .output()?;

    if !output.status.success() {
        return Ok(None);
    }

    let root = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if root.as_os_str().is_empty() {
        return Ok(None);
    }

    Ok(Some(std::fs::canonicalize(absolute_path(&root)?)?))
}

fn absolute_path(path: &Path) -> FrilVaultResult<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    Ok(std::env::current_dir()?.join(path))
}

fn canonicalize_with_missing_components(path: &Path) -> FrilVaultResult<PathBuf> {
    let mut existing_ancestor = path;
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| std::io::Error::other("path has no existing ancestor"))?;
    }

    let missing = path
        .strip_prefix(existing_ancestor)
        .map_err(|_| std::io::Error::other("path is not under its existing ancestor"))?;

    Ok(std::fs::canonicalize(existing_ancestor)?.join(missing))
}

fn existing_ancestor(path: &Path) -> FrilVaultResult<PathBuf> {
    let mut existing_ancestor = path;
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| std::io::Error::other("path has no existing ancestor"))?;
    }

    Ok(std::fs::canonicalize(existing_ancestor)?)
}

fn git_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
