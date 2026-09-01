use anyhow::Result;
use std::path::Path;

use crate::{
    cli::stats::StatsCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: StatsCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: StatsCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;

    let stats = service.stats()?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&stats)?;
        return Ok(());
    }

    println!("Workspace Statistics\n");

    println!("Files: {}", stats.file_count,);

    println!("Total Notes: {}", stats.total_notes,);

    println!("Existing Files: {}", stats.existing_files,);

    println!("Missing Files: {}", stats.missing_files,);

    println!();

    println!("Line Notes: {}", stats.line_notes,);

    println!("Symbol Notes: {}", stats.symbol_notes,);

    Ok(())
}
