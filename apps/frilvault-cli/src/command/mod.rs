use std::path::Path;

use anyhow::Result;
use frilvault_core::FrilVault;

pub mod add;
pub mod attach;
pub mod delete;
pub mod doctor;
pub mod explorer;
pub mod gitignore;
pub mod index;
pub mod init;
pub mod list;
pub mod repair;
pub mod resolve_uri;
pub mod search;
pub mod stats;
pub mod status;
pub mod sync;
pub mod tag;
pub mod update;

pub(crate) fn open_vault(vault_path: Option<&Path>) -> Result<FrilVault> {
    let workspace_root = std::env::current_dir()?;

    Ok(match vault_path {
        Some(vault_path) => FrilVault::open_with_vault_path(&workspace_root, vault_path)?,
        None => FrilVault::open(&workspace_root)?,
    })
}
