use anyhow::Result;
use std::path::Path;

use uuid::Uuid;

use crate::cli::delete::DeleteCommand;

pub fn execute(command: DeleteCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: DeleteCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.notes()?;

    service.delete_note(&command.file, Uuid::parse_str(&command.id)?)?;

    println!("Note deleted");

    Ok(())
}
