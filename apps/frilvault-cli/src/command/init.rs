use anyhow::Result;
use frilvault_core::{FrilVault, GitExcludeStatus, VaultMode};
use serde::Serialize;

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
    let requested_mode = if command.shared {
        VaultMode::Shared
    } else {
        VaultMode::Local
    };
    let vault = FrilVault::open(std::env::current_dir()?)?;
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
    println!("Vault: .vault");
    println!("Mode: {}", result.mode.as_str());

    if result.git_exclude == Some(GitExcludeStatus::VaultTracked) {
        eprintln!();
        eprintln!("Warning: .vault is already tracked by Git.");
        eprintln!("Local exclude rules do not affect tracked files.");
        eprintln!();
        eprintln!("To stop tracking it, run:");
        eprintln!();
        eprintln!("  git rm -r --cached .vault");
    }

    Ok(())
}
