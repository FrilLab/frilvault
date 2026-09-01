use anyhow::Result;
use std::path::Path;

use crate::{
    cli::health::HealthCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: HealthCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: HealthCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;

    let health = service.health_check()?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&health)?;
        return Ok(());
    }

    println!("Workspace Health Check\n");

    if health.missing_source_files.is_empty() {
        println!("No missing source files.");

        return Ok(());
    }

    println!("Missing Source Files\n");

    for file in health.missing_source_files {
        println!("- {}", file);
    }

    Ok(())
}
