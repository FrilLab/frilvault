use anyhow::Result;
use frilvault_core::FrilVault;

use crate::{
    cli::index::IndexCommand,
    output::{OutputFormat, print_json, resolve_format},
};

pub fn execute(command: IndexCommand) -> Result<()> {
    let vault = FrilVault::open(std::env::current_dir()?)?;
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
