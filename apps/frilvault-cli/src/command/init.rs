use anyhow::Result;
use frilvault_core::{FrilVault, VaultMode};

use crate::cli::init::InitCommand;

pub fn execute(command: InitCommand) -> Result<()> {
    let requested_mode = if command.shared {
        VaultMode::Shared
    } else {
        VaultMode::Local
    };
    let vault = FrilVault::open(std::env::current_dir()?)?;
    let mode = vault.initialize(requested_mode)?;

    println!("Initialized FrilVault workspace");
    println!();
    println!("Vault: .vault");
    println!("Mode: {}", mode.as_str());

    Ok(())
}
