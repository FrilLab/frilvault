use anyhow::Result;
use frilvault_core::NoteQuery;
use std::path::Path;

use crate::{
    cli::list::ListCommand,
    output::{print_notes, resolve_format},
};

pub fn execute(command: ListCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: ListCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;

    let notes = service.query_notes(&NoteQuery {
        source_file: Some(command.file.into()),
        keyword: None,
        tag: None,
    })?;
    let format = resolve_format(command.format);

    print_notes(&notes, format)?;

    Ok(())
}
