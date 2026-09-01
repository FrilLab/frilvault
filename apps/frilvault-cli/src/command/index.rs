use anyhow::Result;
use std::path::Path;

use crate::{
    cli::index::IndexCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: IndexCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: IndexCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;

    let index = service.index()?;

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&index)?;
        return Ok(());
    }

    println!("Workspace Index\n");

    for file in index.files {
        println!("{} ({})", file.source_file, file.note_count);
    }

    Ok(())
}
