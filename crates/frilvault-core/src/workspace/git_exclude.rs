use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::Serialize;

use crate::FrilVaultResult;

const VAULT_EXCLUDE_ENTRY: &str = ".vault/";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitExcludeStatus {
    Added,
    AlreadyExcluded,
    NotGitRepository,
    VaultTracked,
}

pub fn ensure_local_vault_excluded(workspace_root: &Path) -> FrilVaultResult<GitExcludeStatus> {
    let Some(exclude_path) = resolve_exclude_path(workspace_root) else {
        return Ok(GitExcludeStatus::NotGitRepository);
    };

    if is_vault_tracked(workspace_root) {
        return Ok(GitExcludeStatus::VaultTracked);
    }

    let existing = if exclude_path.exists() {
        fs::read_to_string(&exclude_path)?
    } else {
        String::new()
    };

    if existing.lines().any(is_vault_exclude_pattern) {
        return Ok(GitExcludeStatus::AlreadyExcluded);
    }

    if let Some(parent) = exclude_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(VAULT_EXCLUDE_ENTRY);
    updated.push('\n');
    fs::write(exclude_path, updated)?;

    Ok(GitExcludeStatus::Added)
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

fn is_vault_tracked(workspace_root: &Path) -> bool {
    Command::new("git")
        .args(["-C"])
        .arg(workspace_root)
        .args(["ls-files", "--", ".vault"])
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

fn is_vault_exclude_pattern(line: &str) -> bool {
    let pattern = line.split('#').next().unwrap_or("").trim();
    matches!(pattern, ".vault" | ".vault/" | "**/.vault" | "**/.vault/")
}
