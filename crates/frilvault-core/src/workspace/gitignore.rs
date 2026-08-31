use std::fs;
use std::path::Path;

use crate::{FrilVaultResult, constants::VAULT_DIR_NAME};

const GITIGNORE_ENTRY: &str = ".vault/";

pub fn is_vault_gitignored(workspace_root: &Path) -> FrilVaultResult<bool> {
    is_vault_gitignored_at(workspace_root, &workspace_root.join(VAULT_DIR_NAME))
}

pub fn is_vault_gitignored_at(workspace_root: &Path, vault_root: &Path) -> FrilVaultResult<bool> {
    let Some(relative_vault) = relative_vault_path(workspace_root, vault_root) else {
        return Ok(false);
    };

    let gitignore_path = workspace_root.join(".gitignore");

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
    let Some(relative_vault) = relative_vault_path(workspace_root, vault_root) else {
        return Ok(());
    };

    if is_vault_gitignored_at(workspace_root, vault_root)? {
        return Ok(());
    }

    let gitignore_path = workspace_root.join(".gitignore");

    if gitignore_path.exists() {
        let mut content = fs::read_to_string(&gitignore_path)?;

        if !content.ends_with('\n') {
            content.push('\n');
        }

        content.push_str(&format!("{}/", relative_vault.to_string_lossy()));
        content.push('\n');
        fs::write(gitignore_path, content)?;
    } else {
        fs::write(
            gitignore_path,
            format!("{}/\n", relative_vault.to_string_lossy()),
        )?;
    }

    Ok(())
}

fn is_vault_ignore_pattern(line: &str, relative_vault: &Path) -> bool {
    let line = line.split('#').next().unwrap_or("").trim();

    if line.is_empty() {
        return false;
    }

    let relative = relative_vault.to_string_lossy();
    line == relative
        || line == format!("{relative}/")
        || (relative == VAULT_DIR_NAME
            && (line == VAULT_DIR_NAME
                || line == GITIGNORE_ENTRY
                || line == "**/.vault"
                || line == "**/.vault/"))
}

fn relative_vault_path(workspace_root: &Path, vault_root: &Path) -> Option<std::path::PathBuf> {
    vault_root
        .strip_prefix(workspace_root)
        .ok()
        .map(Path::to_path_buf)
}
