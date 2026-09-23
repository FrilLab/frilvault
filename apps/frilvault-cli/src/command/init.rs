use anyhow::Result;
use frilvault_core::{GitExcludeStatus, VaultMode};
use serde::Serialize;
use std::path::Path;

use crate::{
    cli::init::InitCommand,
    output::{OutputFormat, print_json, resolve_format},
};

#[derive(Serialize)]
struct InitOutput {
    mode: &'static str,
    git_exclude: Option<GitExcludeStatus>,
}

pub fn execute(command: InitCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: InitCommand, vault_path: Option<&Path>) -> Result<()> {
    let requested_mode = if command.shared {
        VaultMode::Shared
    } else {
        VaultMode::Local
    };
    let vault = super::open_vault(vault_path)?;
    let result = vault.initialize_with_status(requested_mode)?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&InitOutput {
            mode: result.mode.as_str(),
            git_exclude: result.git_exclude,
        })?;
        return Ok(());
    }

    println!("Initialized FrilVault workspace");
    println!();
    println!("Vault: {}", vault.vault_path().display());
    println!("Mode: {}", result.mode.as_str());

    if result.git_exclude == Some(GitExcludeStatus::VaultTracked) {
        eprintln!();
        let vault_path = vault.vault_path();
        eprintln!(
            "Warning: {} is already tracked by Git.",
            vault_path.display()
        );
        eprintln!("Local exclude rules do not affect tracked files.");
        eprintln!();
        eprintln!("To stop tracking it, run:");
        eprintln!();
        eprintln!("  git rm -r --cached {}", vault_path.display());
    }

    Ok(())
}
