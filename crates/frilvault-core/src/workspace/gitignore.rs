use std::fs;
use std::path::{Path, PathBuf};

use crate::{FrilVaultError, FrilVaultResult, constants::VAULT_DIR_NAME};

use super::git_exclude::git_repository_relative_path;

const GITIGNORE_ENTRY: &str = ".vault/";

pub fn is_vault_gitignored(workspace_root: &Path) -> FrilVaultResult<bool> {
    is_vault_gitignored_at(workspace_root, &workspace_root.join(VAULT_DIR_NAME))
}

pub fn is_vault_gitignored_at(workspace_root: &Path, vault_root: &Path) -> FrilVaultResult<bool> {
    let Some((gitignore_path, relative_vault)) = gitignore_target(workspace_root, vault_root)?
    else {
        return Ok(false);
    };

    if !gitignore_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(gitignore_path)?;

    Ok(content
        .lines()
        .any(|line| is_vault_ignore_pattern(line, &relative_vault)))
}

pub fn append_vault_to_gitignore(workspace_root: &Path) -> FrilVaultResult<()> {
    append_vault_to_gitignore_at(workspace_root, &workspace_root.join(VAULT_DIR_NAME))
}

pub fn append_vault_to_gitignore_at(
    workspace_root: &Path,
    vault_root: &Path,
) -> FrilVaultResult<()> {
    let Some((gitignore_path, relative_vault)) = gitignore_target(workspace_root, vault_root)?
    else {
        return Err(FrilVaultError::VaultGitignoreUnavailable(
            vault_root.to_path_buf(),
        ));
    };

    if is_vault_gitignored_at(workspace_root, vault_root)? {
        return Ok(());
    }

    if gitignore_path.exists() {
        let mut content = fs::read_to_string(&gitignore_path)?;

        if !content.ends_with('\n') {
            content.push('\n');
        }

        content.push_str(&format!("{}/", git_path_string(&relative_vault)));
        content.push('\n');
        fs::write(gitignore_path, content)?;
    } else {
        fs::write(
            gitignore_path,
            format!("{}/\n", git_path_string(&relative_vault)),
        )?;
    }

    Ok(())
}

fn is_vault_ignore_pattern(line: &str, relative_vault: &Path) -> bool {
    let line = line.split('#').next().unwrap_or("").trim();

    if line.is_empty() {
        return false;
    }

    let relative = git_path_string(relative_vault);
    line == relative
        || line == format!("{relative}/")
        || (relative == VAULT_DIR_NAME
            && (line == VAULT_DIR_NAME
                || line == GITIGNORE_ENTRY
                || line == "**/.vault"
                || line == "**/.vault/"))
}

fn gitignore_target(
    workspace_root: &Path,
    vault_root: &Path,
) -> FrilVaultResult<Option<(PathBuf, PathBuf)>> {
    if let Some(relative_vault) = vault_root.strip_prefix(workspace_root).ok()
        && !relative_vault.as_os_str().is_empty()
    {
        return Ok(Some((
            workspace_root.join(".gitignore"),
            relative_vault.to_path_buf(),
        )));
    }

    Ok(
        git_repository_relative_path(vault_root)?.map(|(repository_root, relative_vault)| {
            (repository_root.join(".gitignore"), relative_vault)
        }),
    )
}

fn git_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
